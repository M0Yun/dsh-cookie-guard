// GitHub API 调用（Node 24 fetch + NODE_USE_ENV_PROXY 走系统代理）。
// token 从 GH_TOKEN 读取，绝不打印。
const token = process.env.GH_TOKEN
if (!token) {
  console.error('GH_TOKEN missing')
  process.exit(2)
}

const base = 'https://api.github.com'
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-cookie-guard',
}

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

const repo = process.env.GH_REPO ?? 'M0Yun/dsh-cookie-guard'
const description =
  '修复 DeepSeek Harness 桌面端（Windows）每次启动都会新增一条 dsh-auth-* 登录 Cookie、从不清理，' +
  '攒到约 70 条后 Cookie 请求头超过 16KB 被回 431（Web authentication failed）打不开的问题。' +
  '插件在 DSH 启动时挂一个后台清理器，DSH 退出即清掉上一轮及更早的 Cookie；只删 dsh-auth-*，其他 Cookie 不动。'

const cmd = process.argv[2] ?? 'repo'

if (cmd === 'repo') {
  const before = await api('GET', `/repos/${repo}`)
  console.log(`before: private=${before.private} description=${before.description ?? '(empty)'}`)
  const after = await api('PATCH', `/repos/${repo}`, { private: false, description })
  console.log(`after:  private=${after.private} description=${after.description?.slice(0, 30)}…`)
  await api('PUT', `/repos/${repo}/topics`, {
    names: ['dsh', 'dsh-plugin', 'deepseek-harness', 'deepseek', 'cookie', 'windows'],
  })
  console.log('topics: dsh, dsh-plugin, deepseek-harness, deepseek, cookie, windows')
}

if (cmd === 'issue') {
  const fs = await import('node:fs')
  const body = fs.readFileSync(new URL('./market-issue.md', import.meta.url), 'utf8')
  const issue = await api('POST', '/repos/2BingLing/dsh-market/issues', {
    title: '【插件提交】dsh-cookie-guard — 修复 DSH 桌面端 Cookie 堆积导致的 431 / 打不开',
    body,
  })
  console.log(`issue: ${issue.html_url}`)
}
