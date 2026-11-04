# dsh-cookie-guard

> DeepSeek Harness 桌面端（Windows）的登录 Cookie 会越攒越多，约 70 次启动后请求头超过 16 KB，本地 Host 直接回 **431**，桌面端报 `Web authentication failed`，表现就是 **DSH 再也打不开**。
> 这个插件把这个问题从根上处理掉：启动前清掉旧 Cookie，并在需要时把桌面/开始菜单快捷方式指到一个带清理的启动器。

[English](#english) · [原理](#原理) · [用法](#用法) · [回滚](#回滚)

---

## 原理

桌面端启动 Host 后，用一个一次性 launch token 换浏览器登录 Cookie。Cookie 名在 `@deepseek-ai/dsh-client-connection` 里是这样算的：

```js
const COOKIE_PREFIX = "dsh-auth-";
function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}
// authority = "127.0.0.1:<随机端口>"
```

Host **每次启动都用新的随机端口**，所以每次启动的 Cookie 名都不一样；`Max-Age` 是几十天，Chromium 不会主动清，DSH 自己也没有任何删除旧 Cookie 的代码。于是：

| 启动次数 | 沉积的 `dsh-auth-*` | Cookie 请求头 |
| --- | --- | --- |
| 1 | 1 条 | ~0.2 KB |
| 30 | 30 条 | ~6 KB |
| 70 | 70 条 | **> 16 KB → 431** |

Node 的 HTTP 服务默认 `maxHeaderSize` 是 16 KB，超了直接 431。桌面端在拿登录态时先失败，于是整个应用起不来。

## 插件做什么

1. **启动前清理**：`launch-dsh.vbs` → `start-dsh.ps1`：确认 DSH 没在运行 → 抢到 Cookie 库独占锁 → 删掉所有 `dsh-auth-*`（其他 Cookie 一条不动）→ VACUUM → 拉起 DSH。
2. **安装守护**：把脚本装到 `%LOCALAPPDATA%\dsh-cookie-guard`，并把桌面 / 开始菜单的 `DeepSeek Harness.lnk` 改成指向启动器（图标不变，DSH 已在运行时点它只聚焦窗口）。
3. **一个工具**：`cookie_guard`，四个动作：

| action | 作用 |
| --- | --- |
| `status` | Cookie 库大小、估算 Cookie 数与请求头、启动器是否安装、两个快捷方式现在指向哪 |
| `install` / `repair` | 安装或重装守护（重装快捷方式、更新 app 路径） |
| `uninstall` | 移除守护，快捷方式恢复成直启 exe |

4. 启动时只做一次只读体检：Cookie 库超过 256 KB 时打一条 warn，不写任何文件。

## 安装

```bash
# 作为 DSH profile 的 bundle 安装
dsh plugin add dsh-cookie-guard
```

装完重启 Harness，然后让 agent 执行：

```
cookie_guard({ action: "install" })
```

或者手动跑：

```powershell
powershell -File "$env:LOCALAPPDATA\dsh-cookie-guard\install-guard.ps1"
```

### 依赖

- Windows 10/11
- Node.js ≥ 20（DSH 自带）
- `python`（清理 SQLite 用，Windows 上通常已有；也可以用 `py` 安装，脚本会在缺失时跳过并记日志）
- PowerShell 5.1+（系统自带）

## 行为细节

- **DSH 在运行**：点快捷方式只把窗口切到前台，不起第二个实例，也不等待。
- **DSH 未运行**：等它释放 Cookie 库（最多 3 秒）→ 清理 → 启动。
- **备份**：每次清理前把 `Cookies` 复制到 `%LOCALAPPDATA%\dsh-cookie-guard\backups\`，只保留最近 10 份。
- **日志**：`%LOCALAPPDATA%\dsh-cookie-guard\guard.log`，一次运行一行，形如
  `before: total=62 local=61 dsh_auth=60 approx_local_header=4276B removed=60 total_after=2`。

## 局限

- 只有从**桌面 / 开始菜单快捷方式**启动才会清理；直接双击 `DeepSeek Harness.exe` 绕过启动器。
- 应用内「更新后自动重启」会绕过启动器一次，攒 1 条 Cookie，影响可忽略。
- 迁移过安装目录（重装到别处）后，跑一次 `cookie_guard({ action: "repair" })`。
- 不要并发开多个 DSH 实例：Cookie 名绑定 authority，最后一个启动的会覆盖前一个的登录态（这是 DSH 本身的设计，不是本插件引入的）。

## 回滚

```powershell
# 插件内
cookie_guard({ action: "uninstall" })
```

或手动：把快捷方式目标改回 `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`，删掉 `%LOCALAPPDATA%\dsh-cookie-guard` 即可。

## 目录

```
lib/index.js            cordis 插件（工具注册 + 安装/体检逻辑）
assets/launch-dsh.vbs   快捷方式入口（隐藏窗口）
assets/start-dsh.ps1    判断运行状态 → 清理 → 启动
assets/prune-dsh-cookies.ps1  手动清理入口（支持 -DryRun）
assets/guard-lib.ps1    锁检测 / 清理 / 日志
assets/prune_cookies.py SQLite 清理（标准库）
assets/install-guard.ps1      写快捷方式
cordis.patch.yml        bundle 注册行
```

## 参考

- 现象与手工修复：社区反馈的“DSH 永久打不开 / Web authentication failed”，手工步骤即删除
  `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` 与 `Cookies-journal`（数据都在 `.dsh` 里，不会丢）。
- Node HTTP `maxHeaderSize`：<https://nodejs.org/api/cli.html#--max-http-header-size>

## License

MIT © M1zuyn

---

## English

DeepSeek Harness Desktop on Windows writes a fresh `dsh-auth-*` cookie on every launch (the cookie name hashes `127.0.0.1:<random port>`), never removes the old ones, and after ~70 launches the Cookie request header crosses Node's 16 KB limit — the local host answers **431**, the desktop reports `Web authentication failed`, and the app cannot start.

This bundle ships a pre-launch cleaner: it checks the app is closed, deletes every `dsh-auth-*` row from the Chromium cookie jar (nothing else is touched), backs the database up, and then launches the app. It also repoints the desktop and Start-menu shortcuts at that launcher, and exposes a `cookie_guard` tool (`status` / `install` / `repair` / `uninstall`).

Install as a DSH bundle, restart Harness, then run `cookie_guard({ action: "install" })`.

Platform: Windows 10/11, DSH ≥ 0.2.0. The cleaner needs `python` for SQLite; it skips and logs when python is missing.
