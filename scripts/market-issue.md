### 插件提交

- **仓库**：https://github.com/M0Yun/dsh-cookie-guard
- **形态**：cordis-plugin（DSH profile bundle）
- **npm**：`dsh-cookie-guard`（发布后 `dsh plugin add dsh-cookie-guard` 一键安装）
- **平台**：Windows 10/11 桌面端
- **DSH 版本**：`engines.dsh >= 0.2.0`，Node ≥ 22.5（用内置 `node:sqlite`，零依赖）
- **许可证**：MIT

### 它解决什么问题

DeepSeek Harness 桌面端（Windows）每次启动都会新增一条登录 Cookie，名字是
`dsh-auth-` + `sha256("127.0.0.1:<随机端口>")`（`@deepseek-ai/dsh-client-connection` 的
`cookieName(authority)`）。端口每次都变，所以每次启动多一条；`Max-Age` 几十天，Chromium 不清，
DSH 也没有清理逻辑。

约 70 条后 Cookie 请求头超过 Node 默认的 16 KB `maxHeaderSize`，本地 Host 返回 **431**，
桌面端报 `Web authentication failed`，用户看到的就是 **DSH 永久打不开**。手工删
`%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` 只能救一次，下次启动继续积累。

### 插件怎么做

不加启动器、不改快捷方式：

1. 插件加载时 detach 一个后台清理进程；
2. 它每 15 秒探测 Cookies 库能否独占打开（Chromium 运行期间独占，打不开 = DSH 还在跑）；
3. DSH 一退出就 `delete from cookies where name like 'dsh-auth-%'` + `VACUUM`，然后退出。

下次启动只剩本次的一条，请求头稳定在几百字节。

### 安装

```bash
dsh plugin add dsh-cookie-guard
```

### 验证过什么

- 造了 62 条 Cookie 的库（60 条 `dsh-auth-*` + 2 条无关），清理后剩 2 条，
  `api.deepseek.com` 与另一条 `127.0.0.1` Cookie 完好；
- 用一个独占句柄模拟 DSH 运行：清理器等 3.9 秒直到句柄释放，随后立即清理成功；
- 未加锁时直接清理并退出，日志落在 `Network.guard.log`。

### 说明

清理发生在 DSH 退出后，装完第一次要退出一次 DSH 才见效；只清 `dsh-auth-*`，其他 Cookie 不动。
