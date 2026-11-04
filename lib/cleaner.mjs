/**
 * 后台清理器：等 DeepSeek Harness 退出、Cookie 库解锁后，删掉上一轮及更早的
 * dsh-auth-* 登录 Cookie，然后自己退出。
 *
 * 为什么需要独立进程：Chromium 独占打开 Cookies 库，DSH 运行期间连读都读不到。
 * 所以插件在 Host 启动时把这个进程 detach 出去，它会一直等到库解锁为止。
 *
 * 用法：node cleaner.mjs --db <Cookies 路径> [--interval 15000] [--max-hours 24]
 */

import { DatabaseSync } from 'node:sqlite'
import { appendFile, open, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
const opt = { db: '', interval: 15000, maxHours: 24, quiet: false }
for (let i = 0; i < argv.length; i += 1) {
  const key = argv[i]
  if (key === '--db') opt.db = argv[++i] ?? ''
  else if (key === '--interval') opt.interval = Number(argv[++i]) || 15000
  else if (key === '--max-hours') opt.maxHours = Number(argv[++i]) || 24
  else if (key === '--quiet') opt.quiet = true
}

if (!opt.db) {
  process.exit(2)
}

const pidFile = `${opt.db}.guard.pid`
const logFile = `${dirname(opt.db)}.guard.log`

function say(text) {
  if (opt.quiet) return
  process.stdout.write(`[cookie-guard] ${text}\n`)
}

async function log(text) {
  const line = `${new Date().toISOString()} ${text}\n`
  try {
    await appendFile(logFile, line, 'utf8')
  } catch {}
}

async function isLocked(path) {
  try {
    const handle = await open(path, 'r+')
    await handle.close()
    return false
  } catch {
    return true
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 删掉所有 dsh-auth-*，返回 {removed, remaining}。 */
function prune(path) {
  const db = new DatabaseSync(path)
  try {
    const before = db.prepare('select count(*) as n from cookies').get().n
    const result = db.prepare("delete from cookies where name like 'dsh-auth-%'").run()
    db.exec('vacuum')
    const after = db.prepare('select count(*) as n from cookies').get().n
    return { removed: Number(result.changes ?? 0), before, after }
  } finally {
    db.close()
  }
}

async function writePid() {
  try {
    await writeFile(pidFile, String(process.pid), 'utf8')
  } catch {}
}

async function clearPid() {
  try {
    await rm(pidFile, { force: true })
  } catch {}
}

const deadline = Date.now() + opt.maxHours * 3600 * 1000
await writePid()
say(`watching ${opt.db}`)

try {
  while (true) {
    if (!existsSync(opt.db)) {
      say('cookie database disappeared, exit')
      break
    }
    if (!(await isLocked(opt.db))) {
      const result = prune(opt.db)
      await log(`pruned ${result.removed} cookie(s); ${result.before} -> ${result.after}`)
      say(`pruned ${result.removed} cookie(s), ${result.before} -> ${result.after} left`)
      break
    }
    if (Date.now() > deadline) {
      await log('gave up: app still running after max-hours')
      say('gave up: app still running')
      break
    }
    // 心跳：让宿主判断这个 pid 文件是不是残留。
    await writePid()
    await sleep(opt.interval)
  }
} catch (error) {
  await log(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await clearPid()
}
