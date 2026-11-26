# 账号池面板（已启用）

## 状态

**已按 magpie 的正确契约重写并启用**（2026-11-27 07:05）。

## 关键认知修正（之前判断错了）

第一次尝试失败时，我以为是「本地目录 spec 不被 magpie 识别」。查 marvis 的 `tests/panel-manifest.test.mjs` 后发现真正原因：

```
test("面板不得自己发网络请求（沙箱里也没有网络）", () => {
    assert.ok(!/\bfetch\s*\(/.test(js), "面板不该 fetch：越权也没有网络")
})
```

**面板跑在 sandbox 里（`connect-src 'none'`），没有网络。** 第一版 `pool.js` 用 `fetch('/v1/magpie/quotas')` 和 `fetch('/v1/magpie/quotas/refresh')` —— 这在面板里永远失败，「一键刷新」按钮不可能工作。

另外：`panels` **不会**写进 `plugin-providers.json`（marvis / meoo 也都不在里面），所以「配置里搜不到 panels」不能当作未注册的证据 —— 那是误判。

## 正确契约（出处：magpie `docs/subsystems/plugin-runtime.md` P5）

- `panels: [{ slot, file, title }]`，`slot ∈ {agents, usage, settings, provider}`
- `file` 必须是插件目录里的 `.html`，且要在 `package.json` 的 `files` 白名单里
- 面板必须加载 `<script src="_magpie/bridge.js">`
- 面板通过 `magpie.options.get()` / `.set()` 读写**本插件选项**
- `options.set` 是**整份替换**（一秒最多一次），写回必须展开读到的整份 opts
- **面板无网络**：数据只能来自插件主进程写好的文件

## 实现

| 文件 | 作用 |
|---|---|
| `pool.html` | 结构：概览 + 账号网格 + 选项编辑区 |
| `pool.js` | 读 `globalThis.__OR_POOL__` 渲染；`magpie.options.get/set` 编辑 failover 选项；**无 fetch** |
| `pool.css` | 跟随 magpie 主题变量（`--fg` / `--muted` / `--border` / `--accent`） |
| `pool-state.js` | **自动生成**，插件每次 quota 刷新后写入；面板的唯一数据源 |

插件侧：`src/hooks/poolstate.mjs` 负责写快照，`src/hooks/usage.mjs` 在每次 `auth.usage` 后并入账号池并落盘（进程重启会从 `pool-state.js` 恢复）。

## 面板能做什么

1. **账号池概览**：总数 / 有额度 / 已用尽 / 剩余请求总数
2. **账号网格**：每个账号一根进度条（剩余/上限），按剩余降序
3. **Failover 选项编辑**（magpie 原生只支持布尔开关，数值项必须走面板）：
   - `fallbackToHealthy` 死模型自动改投健康模型
   - `healthyModelsOnly` 只列健康模型
   - `freeOnly` 只列免费模型
   - `requestIntervalMs` 每 key 最小间隔
   - `freeRpmLimit` 免费模型每分钟上限
   - `dailyGuard` 日额度耗尽时短路

## 「一键刷新」的正确做法

面板里做不了（无网络）。用这两个：

```powershell
# 桌面快捷方式：OpenRouter一键刷新.lnk
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\c\Documents\deepseek-harness\default-workspace\api-registrar\一键刷新状态.ps1"
```

或 `magpie quota refresh openrouter-live`（刷新后面板数据也会更新）。

## 验证记录（2026-11-27 07:04）

- `magpie quota refresh openrouter-live` → `panel/pool-state.js` 生成 8959 字节，含 58 账号额度
- 网关 3/3 实测 200
- 全量测试 64 passed
- GUI 面板是否显示需人工在 magpie 界面确认（面板由 GUI 应用层提供，gateway 路由探测不到属正常）