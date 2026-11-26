# 账号池面板（已注册，但内容 404）

## 当前状态（2026-11-27 07:20 实测）

| 环节 | 状态 |
|---|---|
| `magpie.panels` 声明被识别 | ✅ GUI 里出现「账号池」标题 |
| 面板 HTML 被 serve | ❌ GUI 里显示 `404 page not found` |
| 面板数据管道（文件） | ✅ 插件写 `panel/pool-state.js`（8959 字节，58 账号） |
| 面板数据管道（options） | ⚠ 未生效（`client.auth.set` 用法待确认） |
| 插件主功能 | ✅ 网关 3/3 实测 200，64 测试通过 |

## 已排除的原因

1. **不是「未注册」** —— 标题「账号池」出现在 GUI 里，说明 `package.json` 的 `magpie.panels` 被读取并渲染。
2. **不是 `panels` 没写进 `plugin-providers.json`** —— marvis / meoo 也都不在里面，本来就存在别的地方。
3. **不是面板里 `fetch` 被拦** —— 已改成零网络（数据走 state 文件 + options），问题发生在 HTML 加载之前。
4. **不是 CSS/JS 相对路径** —— 已把 CSS 与 JS 全部内联进 `pool.html`，仍 404，说明 HTML 本身就没返回。
5. **不是 gateway 路由** —— `/_magpie/bridge.js`、`/api/plugin-panels/*` 在 gateway（127.0.0.1:3425）上全 404；panel 文件由 **GUI 应用层**提供，不在 gateway。

## 最可能的根因

从 magpie.exe 提取到的路由线索：`/api/plugin-panels`（复数，POST）、`gui.pluginPanel`、`gui.apiFramed`、`panelside.go` / `panelkey.go`。

panel 文件由 GUI 应用层按「**已安装包**」的路径解析。本插件的 spec 是**本地目录**：

```
C:\Users\c\AppData\Local\magpie\plugins-src\magpie-openrouter-bulk
```

而能正常工作的 marvis / meoo 都是远程包：

```
github:cat-clash/magpie-marvis
```

**推测**：本地目录 spec 时，magpie 没有把插件目录登记为可 serve 的静态资源根，于是 iframe 请求返回 Go 的默认 `404 page not found`。

## 待验证（需用户决定是否冒险）

把插件改从 GitHub 安装（仓库已有：`cat-clash/magpie-openrouter-bulk`），看面板是否恢复。

风险与对策：
- **可能影响账号绑定**：magpie 会重装插件到 `node_modules`，`accountId` 可能变化
- 必须先备份：`plugin-auth.json`、`providers.json`（含 `accountNames` 58 条别名）、`plugins.json`
- 原 spec 记录在此，失败可回滚：`C:\Users\c\AppData\Local\magpie\plugins-src\magpie-openrouter-bulk`
- 切换后必须跑 `api-registrar/test_gateway.py` 确认 3/3，并检查 `providers.json` 的 `off` 字段（KNOWN_ISSUES 陷阱 #6）

## 「一键刷新」的可用替代（不依赖面板）

面板沙箱无网络，本来也做不了「一键刷新」。用这两个：

```powershell
# 桌面快捷方式：OpenRouter一键刷新.lnk
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\c\Documents\deepseek-harness\default-workspace\api-registrar\一键刷新状态.ps1"

# 或直接
magpie quota refresh openrouter-live
```

`magpie quota openrouter-live` 现在会显示别名（`or-003 (or...@...)`），比长邮箱好读。

## 文件

| 文件 | 说明 |
|---|---|
| `pool.html` | 已内联 CSS + JS，唯一外部依赖是 `_magpie/bridge.js`（magpie 提供） |
| `pool-state.js` | 插件自动写入（已加入 `.gitignore`），面板的首选数据源 |
| `pool.js` / `pool.css` | 旧版拆分文件，已不被 `pool.html` 引用，保留备查 |