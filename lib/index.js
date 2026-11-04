/**
 * dsh-cookie-guard — DeepSeek Harness 桌面端登录 Cookie 清理插件（Windows）
 *
 * 问题：桌面端把启动令牌换成一个 Cookie，名字是
 *   dsh-auth- + base64url(sha256("127.0.0.1:<随机端口>"))
 * 每次启动端口都变，于是每启动一次就在 Chromium 的 Cookie 库里多留一条，
 * 且没有任何代码清理它。攒到约 70 条时 Cookie 请求头超过 16KB，本地 Host
 * 回 431，桌面端报 "Web authentication failed"，表现就是 DSH 再也打不开。
 *
 * 本插件不碰 app.asar（更新会覆盖），而是提供一套“启动前清理”的守护：
 *   - 把启动器脚本安装到 %LOCALAPPDATA%\dsh-cookie-guard
 *   - 把桌面/开始菜单快捷方式指向启动器（启动前先删旧 dsh-auth-* Cookie）
 *   - 提供 cookie_guard 工具：status / install / repair / uninstall
 *
 * 零依赖：只用 node: 内置模块 + 系统自带的 powershell 与 python。
 */

import { spawn } from 'node:child_process'
import { access, cp, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-cookie-guard'

// cordis 是严格注入：apply 里用到的服务必须在这里声明。
export const inject = ['tools']

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = join(PKG_ROOT, 'assets')
const LAUNCHER_NAME = 'dsh-cookie-guard'
const COOKIE_PREFIX = 'dsh-auth-'
/** 16KB 的请求头上限；单条 dsh Cookie 约 230 字节。 */
const HEADER_LIMIT_BYTES = 16 * 1024
const WARN_DB_BYTES = 256 * 1024

const isWindows = process.platform === 'win32'
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? ''
const ROAMING_APP_DATA = process.env.APPDATA ?? ''
const INSTALL_DIR = join(LOCAL_APP_DATA, LAUNCHER_NAME)
const COOKIE_DB = join(ROAMING_APP_DATA, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
const SHORTCUTS = [
  join(process.env.USERPROFILE ?? '', 'Desktop', 'DeepSeek Harness.lnk'),
  join(ROAMING_APP_DATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk'),
]

const textRender = (makeText) => (_args, value) => [{ type: 'text', text: makeText(value) }]

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function powershell(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve({ code: -1, stdout, stderr: stderr + '\n(timed out)' })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error) })
    })
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const runScript = (script, args = [], timeoutMs = 60000) =>
  powershell(['-File', script, ...args], timeoutMs)

async function readShortcuts() {
  const query = `
$ws = New-Object -ComObject WScript.Shell
foreach ($p in @(${SHORTCUTS.map((s) => `'${s.replaceAll("'", "''")}'`).join(', ')})) {
  if (Test-Path -LiteralPath $p) {
    $s = $ws.CreateShortcut($p)
    Write-Output ($p + '|' + $s.TargetPath + '|' + $s.Arguments)
  }
}`
  const result = await powershell(['-Command', query], 20000)
  const rows = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    const [path, target = '', args = ''] = text.split('|')
    rows.push({
      path,
      target,
      arguments: args,
      pointsAtLauncher: /wscript\.exe$/i.test(target) && args.includes('launch-dsh.vbs'),
    })
  }
  return rows
}

async function detectAppExe() {
  const fromFile = join(INSTALL_DIR, 'app-path.txt')
  if (existsSync(fromFile)) {
    const value = (await readFile(fromFile, 'utf8')).trim()
    if (value && existsSync(value)) return value
  }
  const candidates = [
    process.env.DSH_DESKTOP_EXE,
    join(LOCAL_APP_DATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    join(process.env.ProgramFiles ?? '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

async function dbState() {
  if (!existsSync(COOKIE_DB)) return { found: false, locked: false }
  const info = await stat(COOKIE_DB)
  // Chromium 独占打开 Cookie 库，进程内读不到行数；这里只报文件层面的事实，
  // 精确条数由启动前的清理脚本打印（那时库里没有别的进程）。
  let locked = false
  try {
    const handle = await open(COOKIE_DB, 'r+')
    await handle.close()
  } catch {
    locked = true
  }
  return {
    found: true,
    bytes: info.size,
    kilobytes: Math.round(info.size / 1024),
    updatedAt: info.mtime?.toISOString?.() ?? '',
    locked,
  }
}

async function countBackups() {
  const dir = join(INSTALL_DIR, 'backups')
  if (!existsSync(dir)) return 0
  const { readdir } = await import('node:fs/promises')
  try {
    return (await readdir(dir)).filter((entry) => entry.startsWith('Cookies-')).length
  } catch {
    return 0
  }
}

async function status() {
  if (!isWindows) return { ok: false, summary: '仅支持 Windows。' }
  const db = await dbState()
  const launcherInstalled = existsSync(join(INSTALL_DIR, 'launch-dsh.vbs'))
  const shortcuts = launcherInstalled ? await readShortcuts() : []
  const lines = [
    `启动器目录：${INSTALL_DIR}（${launcherInstalled ? '已安装' : '未安装'}）`,
    `Cookie 库：${COOKIE_DB}`,
    db.found
      ? `  ${db.kilobytes} KB（${db.bytes} 字节）${db.locked ? '，DSH 运行中，库被独占，读不到条数' : ''}`
      : '  （未找到，桌面端可能未启动过）',
    `备份份数：${await countBackups()}`,
  ]
  for (const shortcut of shortcuts) {
    lines.push(
      `快捷方式：${shortcut.path}\n  → ${shortcut.target} ${shortcut.arguments}`.trimEnd() +
        `\n  ${shortcut.pointsAtLauncher ? '已指向启动器 ✓' : '仍指向原始 exe ✗'}`,
    )
  }
  return {
    ok: true,
    action: 'status',
    summary: [
      launcherInstalled ? '启动器已安装' : '启动器未安装',
      db.found ? `Cookie 库 ${db.kilobytes} KB` : '未找到 Cookie 库',
      db.found && db.bytes > WARN_DB_BYTES ? '⚠ 体积偏大' : '',
    ]
      .filter(Boolean)
      .join('，'),
    details: lines.join('\n'),
  }
}

async function install(appExe) {
  if (!isWindows) return { ok: false, summary: '仅支持 Windows。' }
  if (!existsSync(ASSETS)) return { ok: false, summary: `插件资源缺失：${ASSETS}` }
  const exe = appExe || (await detectAppExe())
  if (!exe) return { ok: false, summary: '找不到 DeepSeek Harness.exe，请用 appExe 参数指定路径。' }

  await mkdir(INSTALL_DIR, { recursive: true })
  const entries = await (await import('node:fs/promises')).readdir(ASSETS)
  for (const entry of entries) {
    await cp(join(ASSETS, entry), join(INSTALL_DIR, entry), { recursive: true, force: true })
  }

  const result = await runScript(join(INSTALL_DIR, 'install-guard.ps1'), ['-AppExe', exe], 60000)
  if (result.code !== 0) {
    return {
      ok: false,
      summary: '写入快捷方式失败。',
      details: (result.stdout + '\n' + result.stderr).trim(),
    }
  }
  const shortcuts = await readShortcuts()
  const wired = shortcuts.filter((item) => item.pointsAtLauncher).length
  return {
    ok: true,
    action: 'install',
    summary: `启动器已安装，${wired}/${shortcuts.length} 个快捷方式已指向它。`,
    details: [
      `安装目录：${INSTALL_DIR}`,
      `目标程序：${exe}`,
      '',
      ...shortcuts.map((item) => `${item.pointsAtLauncher ? '✓' : '✗'} ${item.path}`),
      '',
      '下次从桌面或开始菜单启动 DSH 时，会先清掉旧的 dsh-auth-* Cookie。',
    ].join('\n'),
  }
}

async function uninstall() {
  if (!isWindows) return { ok: false, summary: '仅支持 Windows。' }
  const exe = await detectAppExe()
  if (exe) {
    const restore = `
$ws = New-Object -ComObject WScript.Shell
$exe = '${exe.replaceAll("'", "''")}'
foreach ($p in @(${SHORTCUTS.map((s) => `'${s.replaceAll("'", "''")}'`).join(', ')})) {
  if (Test-Path -LiteralPath $p) {
    $s = $ws.CreateShortcut($p)
    if ([IO.Path]::GetFileName($s.TargetPath) -ieq 'wscript.exe') {
      $s.TargetPath = $exe
      $s.Arguments = ''
      $s.IconLocation = "$exe,0"
      $s.Save()
    }
  }
}`
    await powershell(['-Command', restore], 30000)
  }
  await rm(INSTALL_DIR, { recursive: true, force: true })
  return {
    ok: true,
    action: 'uninstall',
    summary: '启动器已移除，快捷方式已恢复。',
    details: exe ? `快捷方式目标恢复为：${exe}` : '未找到原程序路径，快捷方式未改动。',
  }
}

export function apply(ctx, config = {}) {
  const cfg = config ?? {}

  const run = async (action, appExe) => {
    switch (action) {
      case 'status':
        return status()
      case 'install':
      case 'repair':
        return install(appExe ?? cfg.appExe ?? '')
      case 'uninstall':
        return uninstall()
      default:
        return { ok: false, summary: `未知 action：${action}` }
    }
  }

  ctx.tools.register({
    name: 'cookie_guard',
    description:
      '修复 Windows 版 DeepSeek Harness 桌面端的登录 Cookie 堆积问题：桌面端每次启动都会往 Chromium 的 Cookie 库里新增一条 ' +
      'dsh-auth-*（名字含随机端口），从不清理，约 70 次启动后 Cookie 请求头超过 16KB，本地 Host 回 431，DSH 报 Web authentication failed 打不开。' +
      '这个工具安装“启动前清理”的守护：把启动脚本放到 %LOCALAPPDATA%\\dsh-cookie-guard，并把桌面/开始菜单快捷方式指向它。' +
      'action=status 查看现状，action=install（或 repair）安装/修复，action=uninstall 还原。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'install', 'repair', 'uninstall'],
          description: 'status=查看现状；install/repair=安装或重装守护；uninstall=移除守护并恢复快捷方式。',
        },
        appExe: {
          type: 'string',
          description: '可选，DeepSeek Harness.exe 的完整路径；省略时自动探测。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          summary: { type: 'string' },
          details: { type: 'string' },
        },
        required: ['ok', 'summary'],
      },
      render: textRender((value) => {
        const head = `${value.ok ? '✓' : '✗'} ${value.summary ?? ''}`
        return value.details ? `${head}\n\n${value.details}` : head
      }),
    },
    async execute(args) {
      const action = String(args?.action ?? 'status')
      const appExe = typeof args?.appExe === 'string' && args.appExe ? args.appExe : ''
      try {
        const result = await run(action, appExe)
        return { action, ...result }
      } catch (error) {
        return {
          ok: false,
          action,
          summary: `执行失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  })

  // 启动时只做一次轻量检查，不做任何写操作。
  if (isWindows && existsSync(COOKIE_DB)) {
    stat(COOKIE_DB)
      .then((info) => {
        if (info.size > WARN_DB_BYTES) {
          ctx.logger?.warn?.(
            `[dsh-cookie-guard] Cookie 库 ${info.size} 字节，可能已接近 16KB 请求头上限；` +
              `调用 cookie_guard(action:"install") 安装启动前清理。`,
          )
        }
      })
      .catch(() => {})
  }
}

export const __test = { status, install, uninstall, detectAppExe, COOKIE_PREFIX, HEADER_LIMIT_BYTES }
