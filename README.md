# dsh-cookie-guard

> DeepSeek Harness 桌面端（Windows）每次启动都会往 Cookie 库里多留一条登录 Cookie，从不清理。攒到约 70 条时 Cookie 请求头超过 16 KB，本地 Host 直接回 **431**，桌面端报 `Web authentication failed`——表现就是 **DSH 再也打不开**。
>
> 这个插件不给快捷方式加壳、不改启动方式：它在 DSH 启动时挂一个后台清理器，等 DSH 退出、Cookie 库解锁后，删掉上一轮及更早的 `dsh-auth-*`。下一次启动就是干净的。

[English](#english) · [原理](#原理) · [怎么工作](#怎么工作) · [用法](#用法) · [局限](#局限)

---

## 原理

桌面端启动 Host 后，用一个一次性 launch token 换浏览器登录 Cookie。Cookie 名来自 `@deepseek-ai/dsh-client-connection`：

```js
const COOKIE_PREFIX = "dsh-auth-";
function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}
// authority = "127.0.0.1:<随机端口>"
```

Host 每次启动都换随机端口，所以每次启动的 Cookie 名都不一样；`Max-Age` 几十天，Chromium 不会主动清，DSH 里也没有任何删除旧 Cookie 的代码。

| 启动次数 | 沉积的 `dsh-auth-*` | Cookie 请求头 |
| --- | --- | --- |
| 1 | 1 条 | ~0.2 KB |
| 30 | 30 条 | ~6 KB |
| 70 | 70 条 | **> 16 KB → 431** |

Node 的 HTTP 服务默认 `maxHeaderSize` 是 16 KB，超了直接 431；桌面端拿不到登录态，整个应用起不来。

## 怎么工作

1. 插件加载时（Host 启动）`detach` 一个**独立清理进程** `lib/cleaner.mjs`，父进程退出它也不受影响。
2. 清理器每 15 秒探测一次 Cookies 库能否独占打开。
   - 打不开 = DSH 还在跑（Chromium 独占该文件），继续等；
   - 打得开 = DSH 已退出，立刻 `delete from cookies where name like 'dsh-auth-%'` + `VACUUM`，然后自己退出。
3. 下次启动时库里只剩本次要写的那一条，请求头稳定在几百字节。

清理只用 `node:sqlite`（Node 22.5+ 内置），**没有第三方依赖，也不需要 Python/PowerShell**。

## 用法

```bash
dsh plugin add dsh-cookie-guard
```

重启 Harness 后插件开始工作，之后正常开关 DSH 即可，不用改任何习惯。

agent 侧有一个工具：

| action | 作用 |
| --- | --- |
| `status` | Cookie 库体积、`dsh-auth-*` 条数（库未被占用时）、清理器是否在跑、上次清理记录 |
| `clean` | 库已被占用则把清理排到 DSH 退出后；库空着则立刻清一次 |

状态日志：`%APPDATA%\@deepseek-ai\dsh-desktop\Network.guard.log`，一行一次清理，形如
`2026-11-04T16:17:24.467Z pruned 60 cookie(s); 62 -> 2`。

## 局限

- 只清 `dsh-auth-*`，其他 Cookie（包括平台登录）一条不动。
- 清理发生在 **DSH 退出后**：当前这一轮启动期间，库里仍然是上一轮积累的量；第一次装完后要退出一次 DSH 才会初见效果。
- 如果 DSH 长时间不退出，清理器就一直等（默认最多 24 小时，可用 `config.maxHours` 调整）。
- 只支持 Windows 桌面端；Web/headless 不受影响。

## 回滚

```bash
dsh plugin remove dsh-cookie-guard
```

插件只会在 `%APPDATA%\@deepseek-ai\dsh-desktop\Network\` 下写 `Cookies.guard.pid` 和 `Network.guard.log`，删掉即可。

## 目录

```
lib/index.js      cordis 插件：注册 cookie_guard 工具 + 启动清理器
lib/cleaner.mjs   后台清理器：等锁释放 → 删 dsh-auth-* → 退出
cordis.patch.yml  bundle 注册行
```

## License

MIT © M1zuyn

---

## English

DeepSeek Harness Desktop on Windows writes a fresh `dsh-auth-*` cookie on every launch (the name hashes `127.0.0.1:<random port>`), never removes the old ones, and after ~70 launches the Cookie request header crosses Node's 16 KB limit — the local host answers **431**, the desktop reports `Web authentication failed`, and the app cannot start.

No launcher, no shortcut rewriting: when the Host starts, this bundle detaches a small cleaner process. It polls the Chromium cookie database (exclusive lock = app still running) and, as soon as the app exits, deletes every `dsh-auth-*` row, vacuums, and exits. The next launch starts clean.

Zero dependencies — `node:sqlite` (Node ≥ 22.5) only. A `cookie_guard` tool exposes `status` and `clean`.

Caveat: cleanup happens after the current session ends, so the first install only pays off after one full exit of DSH.
