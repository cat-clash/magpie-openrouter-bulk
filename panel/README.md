# 账号池面板（未启用 · 待验证）

## 状态

**面板代码已完成，但 magpie 未加载**，因此 `package.json` 的 `magpie.panels` 声明已暂时移除，避免发布未验证的功能。

## 探测结果（2026-11-27 04:15）

按 marvis 插件（`magpie-marvis-final` v0.8.8）的相同格式声明了 `magpie.panels`：

```json
"panels": [{
  "slot": "provider",
  "title": "账号池 Account pool",
  "titles": { "zh": "账号池", "en": "Account pool" },
  "file": "panel/pool.html"
}]
```

随后：
- `magpie plugin off/on` → 面板未注册
- 重启 magpie 进程 → 面板未注册
- 探测 gateway 路由，全部 404：
  - `/_magpie/panel/magpie-openrouter-bulk/pool.html`
  - `/_magpie/panels/magpie-openrouter-bulk/pool.html`
  - `/_magpie/plugins/magpie-openrouter-bulk/panel/pool.html`
  - `/_magpie/bridge.js`
- `plugin-providers.json` 里 openrouter 条目：`name` 从空更新为 `"OpenRouter"`（说明 package.json 的 magpie 字段确实被读取），但**没有 panels 字段**

## 已知差异

| 项 | 本插件 | marvis |
|---|---|---|
| spec 形态 | `C:\...\plugins-src\magpie-openrouter-bulk`（**本地目录**） | `github:cat-clash/magpie-marvis`（**远程包**） |

**推测**：magpie 可能只对 npm / github 安装的包解析 `magpie.panels` 并从包内提供静态资源路由；本地目录 spec 走的加载路径不同。

## 待验证的下一步

1. 把插件以 `github:` 形式安装（本仓库已推 GitHub），看 panels 是否注册
2. 对比 marvis 在你机器上的面板是否真的可见（若 marvis 面板也不显示，说明是 magpie 版本不支持而非安装方式差异）
3. 检查 GUI 端（非 gateway）的静态路由前缀——`_magpie/bridge.js` 在 gateway 上 404，说明它由 GUI 应用层提供，需从 GUI URL（`http://127.0.0.1:<port>`）探测

## 文件

- `pool.html` — 面板结构（一行概览 + 一键刷新按钮 + 可折叠账号网格）
- `pool.js` — 逻辑：读 `/v1/magpie/quotas?kept=1`、`POST /v1/magpie/quotas/refresh?provider=openrouter-live`
- `pool.css` — 用 magpie 主题变量（`--fg` / `--muted` / `--border` / `--accent`）自动跟随明暗主题

验证通过后，把 `panels` 声明加回 `package.json` 的 `magpie` 字段即可。
