/**
 * dsh-cookie-guard — 自动清理 DeepSeek Harness 桌面端堆积的登录 Cookie（Windows）
 *
 * 问题：桌面端每次启动都用随机端口换一条登录 Cookie，名字是
 *   dsh-auth- + base64url(sha256("127.0.0.1:<端口>"))
 * 端口变了 Cookie 名就变，`Max-Age` 又是几十天，DSH 里没有任何清理逻辑。
 * 攒到约 70 条后 Cookie 请求头超过 Node 的 16KB 上限，本地 Host 回 431，
 * 桌面端报 "Web authentication failed"，也就是再也打不开。
 *
 * 做法：不碰 app.asar、不加启动器、不改快捷方式。插件在 Host 启动时
 * detach 一个后台清理器（lib/cleaner.mjs），它等到 DSH 退出、Cookie 库解锁，
 * 就删掉上一轮及更早的 dsh-auth-*（其他 Cookie 不动）并退出。下一次启动就是干净的。
 *
 * 只用 node: 内置模块（Node 22.5+ 的 node:sqlite），无第三方依赖。
 */

import { spawn } from 'node:child_process'
import { access, appendFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-cookie-guard'

// cordis 是严格注入：apply 里用到的服务必须在这里声明。
export const inject = ['tools']

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLEANER = join(PKG_ROOT, 'lib', 'cleaner.mjs')
const COOKIE_DB = join(
  process.env.APPDATA ?? '',
  '@deepseek-ai',
  'dsh-desktop',
  'Network',
  'Cookies',
)
/** 16KB 是 Node 默认的请求头上限；DSH 单条 Cookie 约 230 字节。 */
const HEADER_LIMIT_BYTES = 16 * 1024

const isWindows = process.platform === 'win32'
const GUARD_LOG = `${dirname(COOKIE_DB)}.guard.log`

async function guardLog(text) {
  try {
    await appendFile(GUARD_LOG, `${new Date().toISOString()} ${text}\n`)
  } catch {}
}

const textRender = (makeText) => (_args, value) => [{ type: 'text', text: makeText(value) }]

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function watcherPid() {
  try {
    const { stat } = await import('node:fs/promises')
    const file = `${COOKIE_DB}.guard.pid`
    const info = await stat(file)
    // 清理器每轮都会刷新 pid 文件；超过 90 秒没刷新就是残留文件。
    if (Date.now() - info.mtimeMs > 90_000) return 0
    const value = (await readFile(file, 'utf8')).trim()
    const pid = Number(value)
    return alive(pid) ? pid : 0
  } catch {
    return 0
  }
}

async function dbFacts() {
  if (!existsSync(COOKIE_DB)) return { found: false }
  const { stat } = await import('node:fs/promises')
  const info = await stat(COOKIE_DB)
  return { found: true, bytes: info.size, kilobytes: Math.round(info.size / 1024) }
}

/** 只在库没被占用时能读到行数。 */
async function countStale() {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(COOKIE_DB, { readOnly: true })
    try {
      const row = db.prepare("select count(*) as n from cookies where name like 'dsh-auth-%'").get()
      const all = db.prepare('select count(*) as n from cookies').get()
      return { stale: Number(row.n), total: Number(all.n) }
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

async function lastLogLine() {
  try {
    const text = await readFile(`${dirname(COOKIE_DB)}.guard.log`, 'utf8')
    const lines = text.trim().split(/\r?\n/)
    return lines.at(-1) ?? ''
  } catch {
    return ''
  }
}

async function status() {
  if (!isWindows) return { ok: false, summary: '仅支持 Windows。' }
  const db = await dbFacts()
  const pid = await watcherPid()
  const counts = db.found ? await countStale() : undefined
  const last = await lastLogLine()
  const lines = [
    `Cookie 库：${COOKIE_DB}`,
    db.found
      ? `  体积 ${db.kilobytes} KB${counts ? `，Cookie ${counts.total} 条，其中 dsh-auth-* ${counts.stale} 条` : '，正被 DSH 占用读不到条数'}`
      : '  （未找到：桌面端可能还没启动过）',
    pid ? `后台清理器：运行中（pid ${pid}），等 DSH 退出后清理` : '后台清理器：未运行（下次启动 DSH 会重新挂上）',
    last ? `上次清理：${last}` : '上次清理：无记录',
  ]
  if (counts && counts.stale > 0) {
    lines.push('', '提示：跑 cookie_guard(action:"clean") 可以让清理器在 DSH 退出时立刻处理，或直接等它自动清。')
  }
  return {
    ok: true,
    action: 'status',
    summary: [
      db.found ? `Cookie 库 ${db.kilobytes} KB` : '未找到 Cookie 库',
      counts ? `dsh-auth-* 共 ${counts.stale} 条` : '库被占用',
      pid ? '清理器在跑' : '清理器未运行',
    ].join('，'),
    details: lines.join('\n'),
  }
}

async function clean() {
  if (!isWindows) return { ok: false, summary: '仅支持 Windows。' }
  const pid = await watcherPid()
  if (!existsSync(COOKIE_DB)) return { ok: false, summary: '没找到 Cookie 库。' }
  const counts = await countStale()
  if (!counts) {
    // 库被占用 = DSH 在跑。主动补挂清理器，避免启动时那一次 spawn 失败后整轮无人守。
    const started = startWatcher()
    const live = await watcherPid()
    return {
      ok: true,
      action: 'clean',
      summary: live
        ? `清理器已就绪（pid ${live}），DSH 退出后立刻清掉 dsh-auth-*。`
        : `没能挂上清理器${started.error ? `：${started.error}` : ''}。`,
      details: live
        ? '退出 DSH 后自动删除上一轮及更早的 dsh-auth-*。'
        : '下次启动 DSH 会再试一次；也可运行 `dsh` 后手动执行 node lib/cleaner.mjs。',
    }
  }
  // 库已经空出来（比如 DSH 刚退出）——直接调用同一套清理逻辑。
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, [CLEANER, '--db', COOKIE_DB, '--max-hours', '0.01'], {
    windowsHide: true,
    encoding: 'utf8',
  })
  return {
    ok: true,
    action: 'clean',
    summary: `已清理：删除 ${counts.stale} 条 dsh-auth-*，剩 ${counts.total - counts.stale} 条其他 Cookie。`,
    details: (result.stdout || '').trim(),
  }
}

/**
 * 起一个 detach 的清理器。
 *
 * 每次都起：上一个清理器可能正好在这一刻完成清理并退出，此时跳过就会导致
 * 这一轮没有清理器（曾真实踩到）。重复的清理器只会多清一次 0 条，无害。
 */
function startWatcher(maxHours = 24) {
  if (!isWindows) return { pid: 0, error: 'unsupported platform' }
  if (!existsSync(COOKIE_DB)) return { pid: 0, error: 'cookie database missing' }
  if (!existsSync(CLEANER)) return { pid: 0, error: 'cleaner script missing' }
  try {
    const child = spawn(process.execPath, [CLEANER, '--db', COOKIE_DB, '--quiet', '--max-hours', String(maxHours)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // Host 本身就是以 ELECTRON_RUN_AS_NODE 启动的；显式传下去，确保子进程跑脚本
      // 而不是再起一个桌面端实例。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.on('error', (error) => {
      void guardLog(`watcher: child error: ${error instanceof Error ? error.message : String(error)}`)
    })
    child.unref()
    const pid = child.pid ?? 0
    void guardLog(`watcher: spawned pid=${pid}`)
    return { pid, error: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    void guardLog(`watcher: spawn failed: ${message}`)
    return { pid: 0, error: message }
  }
}

export function apply(ctx, config = {}) {
  const cfg = config ?? {}
  const maxHours = Number(cfg.maxHours) > 0 ? Number(cfg.maxHours) : 24

  // 起不来就隔 8 秒再试一次（覆盖启动瞬间的抖动），失败都写进 guard.log。
  const boot = async () => {
    if (startWatcher(maxHours).pid) return
    await new Promise((resolve) => setTimeout(resolve, 8000))
    if (await watcherPid()) return
    const retry = startWatcher(maxHours)
    await guardLog(`watcher: retry ${retry.pid ? `ok pid=${retry.pid}` : `failed: ${retry.error}`}`)
  }
  try {
    ctx.effect?.(() => {
      void boot()
      return () => {}
    })
  } catch {
    void boot()
  }

  ctx.tools.register({
    name: 'cookie_guard',
    description:
      'DeepSeek Harness 桌面端（Windows）每次启动都会新增一条 dsh-auth-* 登录 Cookie，从不清理；约 70 次后 Cookie 请求头超过 16KB，' +
      '本地 Host 回 431，DSH 报 Web authentication failed 且打不开。这个插件在 DSH 启动时挂一个后台清理器，等 DSH 退出、Cookie 库解锁后，' +
      '删掉上一轮及更早的 dsh-auth-*（其他 Cookie 不动），下一次启动就是干净的。' +
      'action=status 看现状，action=clean 让清理器立刻在退出后处理。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'clean'],
          description: 'status=查看 Cookie 库与清理器状态；clean=触发一次清理（DSH 运行中则排到退出后）。',
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
      try {
        if (action === 'clean') return await clean()
        if (action === 'status') return await status()
        return { ok: false, summary: `未知 action：${action}` }
      } catch (error) {
        return {
          ok: false,
          action,
          summary: `执行失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  })
}

export const __test = { status, clean, startWatcher, COOKIE_DB, HEADER_LIMIT_BYTES }
