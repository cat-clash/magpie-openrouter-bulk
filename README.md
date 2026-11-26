# magpie-openrouter-bulk

把批量注册的 OpenRouter Key 一次性导入 magpie 的插件方案。

基于 [biyan113/magpie-openrouter](https://github.com/biyan113/magpie-openrouter) 改造，provider id 保持 `openrouter-live`（避开 magpie 内置 `openrouter`），模型写作 `openrouter-live/<id>`。

## 功能

- **批量导入**：`auth.import` 扩展点 + CLI `magpie accounts import openrouter-live <file> --yes`，单次 ≤100 把 key，8 并发逐 key 在线验证
- **模型目录**：登录后自动拉取 OpenRouter 全量 `/models`（约 460+），10 分钟内跨账号共享缓存；离线/未登录时退回内置静态目录（`openrouter/auto` + 真实 `:free` 免费模型）
- **额度（quota）**：`magpie quota` / `magpie accounts` 对每个账号显示 key 限额窗口（$0.00 / $100.00）、免费模型每日请求数（0/50）、今日消耗，以及余额
- **导入即记账**：导入验证时把 `limit` / `limit_remaining` / `usage` / `free_tier` / `free_daily_limit` 快照进账号 metadata，账本里直接可查每把 key 的身价
- **路由**：chat 请求走 `openrouter/auto` 时可按 `options.sort`（price/throughput/latency）注入 `provider.sort`；classifier 走 Decisions API

## 安装

```sh
# 本地路径安装（开发/私有部署）
magpie plugin on "C:\path\to\magpie-openrouter-bulk"
# 或 GitHub 安装
magpie plugin on github:<owner>/magpie-openrouter-bulk
```

装好后把插件目录加进 `plugins.json` 的 `plugins` 列表（spec 为插件根目录路径），或直接用 `magpie plugin on <spec>`。

## 导入文件格式

两种格式均可（GUI「Import accounts from a file…」和 CLI 一样）：

registrar 导出的 `api_keys.json`：

```json
{
  "provider": "openrouter",
  "count": 50,
  "keys": [
    { "key": "sk-or-…", "email": "…", "label": "openrouter-<task_id>" }
  ]
}
```

纯文本 `keys.txt`（每行一个 key，支持 `#` 注释、同行多 key、逗号/分号分隔）：

```text
# 注册批次 2026-11-25
sk-or-v1-aaaaaaaa…
sk-or-v1-bbbbbbbb…, sk-or-v1-cccccccc…
```

导入行为：

- `sk-or-` 格式校验（`KEY_RE`），自动去重
- 逐 key GET `https://openrouter.ai/api/v1/key` 在线验证：401/403 判失败并带上 OpenRouter 返回的错误原因；429/5xx 自动重试（500ms、1500ms 各一次）；每个请求 15s 超时
- 成功项以**顶层 `key`** + `metadata.email` 返回，符合 magpie 的 `keptAs()` / `settle()` 契约：CLI 与 GUI 均可导入，重复导入是「更新」而非新增
- 验证成功后把配额快照写进 metadata（见上）
- 单次最多 100 个（magpie 侧 `IMPORT_MOST=100`），更多请拆文件分批
- `options.verifyImport: false` 可跳过在线验证

```sh
# CLI 批量导入（0.3.0 起对真 key 直接可用）
magpie accounts import openrouter-live api_keys.json --yes
```

> 0.2.0 及更早版本成功项缺少顶层 `key`，全部被 magpie 判为 "gave nothing to keep" / "nothing imported"——那是旧 schema 的坑，已修复。

## quota / 余额说明

每个账号的 `auth.usage` 挂钩（`magpie quota`、`magpie accounts`、菜单栏都会调它）：

- GET `/api/v1/key`：`limit` / `limit_remaining`（key 自己的信用限额，注册号默认 $100）→ 「key limit」窗口；`limit_reset`（daily/weekly/monthly）决定重置时间
- `free_model_daily_requests`（used/limit）→ 「free models」窗口，UTC 每日重置
- `usage_daily` → 「today」窗口
- `effective_budget` / `budgets`（org 管理的预算）非 `key_limit` scope 时单独一个「budget」窗口
- 余额：免费账号没有信用余额时显示 key 的 `limit_remaining`（即 $100 限额剩余）

### 批量账号下的限流保护（0.3.1）

几十个账号 + 代理同一出口 IP 时，GUI 每次刷新全量拉 quota 会把 78+ 请求瞬间打到 OpenRouter，触发 per-IP 突发限流，表现为「暂时无法获取最新额度 · context deadline exceeded」。0.3.1 起：

- **并发闸**：所有账号共享一个全局信号量，同时最多 3 个 usage 请求在飞，每个请求前加 0–300ms 随机抖动打散突发
- **超时 + 重试**：单请求 `AbortSignal` 8s 超时；429/5xx/超时按 500ms→1500ms→3000ms 指数退避，最多重试 3 次
- **跨账号缓存**：成功结果缓存 10 分钟，GUI 刷新在有效期内直接返回缓存、不再打 API；失败结果缓存 60 秒，避免死账号每次刷新都重试
- **partial 容错**：某把 key 瞬时失败时保留上次成功快照并标 `stale`（带时间戳），不再让整体 usage 报错
- **砍掉 `/credits`**：免费层 key 的 `/credits` 无意义（余额 = key limit 已在 `/key` 里），正常路径只打 `/key`，每账号请求数减半

### 「积分 / 余额」到底是什么

注册号是 **Free tier** 账号（`is_free_tier: true`、`GET /credits` 返回 `total_credits: 0`）。两个数字别混：

- **`limit: 100` / 「key limit · $0.00 / $100.00」**：这把 key 的**消费上限**（OpenRouter 的 key guardrail，USD）。它是天花板，不是余额——账号没有充过值，`total_credits` 就是 0，这个 $100 不会变成可用额度。
- **余额**：真实可用余额 = 已充值 credits − 已消耗。免费号是 `$0.00`；插件在没有 credits 时回退显示 `limit_remaining`（= $100 上限剩余），所以看起来像「$100 余额」，实际是「还没花掉的额度上限」。
- **credits 花在哪**：只有**付费模型**按 token 扣 credits（prompt/completion 单价见模型 `pricing`）。`GET /key`、`GET /credits`、`GET /models` 这些探测不消耗 credits。
- **免费额度**：`:free` 模型不扣 credits，只受 `free_model_daily_requests` 限制——每账号 **50 次/天**（UTC 重置），平台另有 20 请求/分钟。

结论：免费号能用什么，只取决于模型是否零价（`:free` 后缀或零价路由），与那 $100 无关。

## 可用模型盘点（2026-11-26 实测）

线上 `/models` 全量 **737** 个模型（插件默认只收文本/决策类，magpie 里显示 459 个）：

| 类别 | 数量 | 免费号能否直接调用 |
| --- | --- | --- |
| 全部模型 | 737 | — |
| `:free` 后缀 | 21 | 仅文本类可用；视频/语音/embedding/rerank 不是聊天模型 |
| 零价文本（非 `:free`） | 1（`openrouter/free` 路由器） | ✅ |
| **文本聊天可用的免费模型** | **12** | ✅ |
| 付费模型 | 627 | ❌ 需要充值 credits，否则 402 insufficient credits |

> 实测：免费号调付费模型返回 402；`GET /credits` = `{total_credits: 0, total_usage: 0}`。

### 当前可用（零价、文本、可直接聊天）的 12 个模型

| 模型 | 上下文 | 最大输出 | tools |
| --- | --- | --- | --- |
| `baidu/ernie-5.5-flash-preview:free` | 1,024,000 | 921,600 | ✓ |
| `google/gemma-4-26b-a4b-it:free` | 262,144 | 32,768 | ✓ |
| `google/gemma-4-31b-it:free` | 262,144 | 32,768 | ✓ |
| `inclusionai/ling-3.2-flash:free` | 1,048,576 | 262,144 | ✓ |
| `liquid/lfm-3-1.7b:free` | 262,144 | 8,192 | ✓ |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256,000 | 65,536 | ✓ |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | 65,536 | ✓ |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 65,536 | ✓ |
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | 131,072 | ✓ |
| `openrouter/free` | 200,000 | — | ✓ |
| `particle-ai/particle-1:free` | 1,048,576 | 131,072 | ✓ |
| `recursive/flint-v1.0:free` | 262,144 | 235,929 | ✓ |

另有 21 个 `:free` 里的 10 个非聊天模型：视频（`google/veo-3.1`、`minimax/hailuo-3`、`bytedance/seedance-*`、`x-ai/grok-imagine-video` 等）、语音（`fish-audio/s2.1-pro-free:free`、`heygen/heygen-voice-1-turbo:free`）、embedding（`nvidia/nemotron-3-embed-1b:free` 等）——插件按 `output_modalities` 过滤，不会进聊天模型列表。

> 想要模型列表只显示这 12 个：设 `options.freeOnly: true`（默认 false，仍列全量 459 个文本模型）。

插件静态兜底目录收录了上述 12 个 + `openrouter/auto`（共 13 项）；登录后以 `/models` 实时目录为准。

## OpenRouter 官网调研要点

- **Key 格式**：`sk-or-v1-` + 64 位小写十六进制，共 73 字符
- **新账号 onboarding key**：默认 $100 信用限额，**180 天过期**（不是一年）
- **GET `/api/v1/key`**（Bearer key）：返回 `label`、`limit`、`limit_remaining`、`limit_reset`、`usage`、`usage_daily/weekly/monthly`、`is_free_tier`、`free_model_daily_requests{used,limit,remaining}`、`budgets`、`effective_budget`、`expires_at`
- **免费模型**：id 以 `:free` 结尾，prompt/completion 价格均为 0。平台限额：**20 请求/分钟**；每日请求数 = 累计充值 < $10 时 **50 次/天**，≥ $10 时 1000 次/天。`free_model_daily_requests` 只报每日计数
- **限流**：key 管理（POST/PATCH/DELETE `/keys`）默认 10,000 次/天；`GET /key`、`/credits`、`GET /keys` 有按 IP 的突发限额（无 `X-RateLimit-*` 头，429 时指数退避重试）
- **402/403 额度类错误**：`error.metadata.limit_source` 区分 `openrouter_key_limit` / `openrouter_credits` / in-flight 预算
- `GET /api/v1/models` 为公开端点（无需鉴权），支持 `limit` / `output_modalities` 参数与 `links.next` 分页

## 直写 plugin-auth.json（兜底路径）

magpie 的插件登录态存在 `<配置目录>/magpie/plugin-auth.json`（无 BOM UTF-8）：

```json
{
  "openrouter-live":        { "type": "api", "key": "sk-or-…", "metadata": { "email": "user0@example.com", "provider": "openrouter-live" } },
  "openrouter-live#user1":  { "type": "api", "key": "sk-or-…", "metadata": { "email": "user1@example.com", "provider": "openrouter-live" } }
}
```

- 第一个账号占 provider id 本身，其余用 `openrouter-live#短名`
- `magpie plugin list` 会把这些识别为同一插件下的多个账号
- 上游插件的 `auth.usage`、`provider.models` 对每个账号独立拉取，401 的账号标记为需重新登录，不影响其他账号
- 带项目 `registrar/magpie_importer.py` 可以自动做这件事（自动备份、幂等去重）
- 文件必须无 BOM；带 BOM 会被 magpie 判定无法解析并改名备份

## 代码结构

`index.mjs` 只做装配（<3KB），钩子实现在 `src/` 下，改哪一块就去看哪个文件：

| 文件 | 职责 |
| --- | --- |
| `index.mjs` | 装配：把六个钩子拼成插件对象；只导出 `OpenRouterPlugin` 与 `_internal` |
| `src/context.mjs` | 常量与静态表：`PROVIDER` / `BASE` / `CATALOG_TTL` / `FREE_MODELS` / `DEAD_MODELS` / `HEALTHY_MODELS` / 导入正则与超时 |
| `src/hooks/config.mjs` | `config` 钩子：provider 声明 + 静态模型表 |
| `src/hooks/options.mjs` | `auth.options`：GUI 开关与 `importFrom` 文案 |
| `src/hooks/import.mjs` | `auth.import`：`parseKeyEntries` / `parseKeyText` / `verifyKey` / `importKeys` |
| `src/hooks/loader.mjs` | `auth.loader`：`prepare()` + 双维度 429 failover |
| `src/hooks/usage.mjs` | `auth.usage`：配额窗口（并发闸 3 + 缓存）与账号自动命名 |
| `src/hooks/models.mjs` | `provider.models`：动态目录 + 静态兜底 + 目录缓存 |
| `failover.mjs` / `catalog.mjs` / `request.mjs` / `usage.mjs` | 根目录底层实现（import 路径不变，`DEAD_MODELS` 事实来源已上移到 `src/context.mjs` 并由 `failover.mjs` 再导出） |

> 入口**只能**导出 `OpenRouterPlugin` 和 `_internal` 两个符号 —— 多导出一个函数，magpie 会把它当成第二个插件。

## 插件选项

写在 `plugins.json` 对应项的 `options`，或 `magpie plugin options magpie-openrouter-bulk '<json>'`：

| 字段 | 含义 |
| --- | --- |
| `referer` | `HTTP-Referer`，默认 `https://usemagpie.ai` |
| `title` | `X-OpenRouter-Title`，默认 `magpie` |
| `sort` | 补全 `provider.sort`：`price`/`throughput`/`latency` |
| `output` | `default`/`text`/`all` |
| `includeAliases` | `true` 时保留 `~` 别名 |
| `verifyImport` | `false` 时 `auth.import` 跳过逐 key 在线验证 |
| `freeOnly` | `true` 时模型列表只保留免费号可用的零价模型（默认 `false`，列全量文本模型） |
| `requestIntervalMs` | 同一把 key 相邻两次请求的最小间隔，默认 `0`（不延迟） |
| `freeRpmLimit` | 免费模型每分钟请求上限，默认 `20`（平台硬限）；`0` 关闭窗口 |
| `rpmScope` | `key`（默认，每 key 一份窗口，与平台语义一致）/ `global`（所有账号共用一份） |
| `dailyGuard` | 默认 `true`：最近一次 `/key` 快照显示免费日额度剩 0 时，请求直接短路成 key 级 429，交给 magpie 换账号 |

### 请求节奏控制（`src/pacing.mjs`）

三件事各自独立、可单独关掉，默认配置下**行为与 0.5.0 一致**（`requestIntervalMs=0` 不引入任何延迟）：

1. **间隔闸** `requestIntervalMs`：同 key 相邻两次放行的最小间隔，摊平突发。
2. **分钟配额滑动窗口** `freeRpmLimit` + `windowMs`（默认 60s）：用**滑动**窗口而非固定窗口——固定窗口在边界会放过 2×限制。超出的请求同步占位后排队到最早一笔滑出窗口。
3. **日额度短路** `dailyGuard`：`:free` 模型每 key 每天 50 次（UTC 0 点重置）。`auth.usage` 每次读 `/key` 都把 `free_model_daily_requests` 剩余额度喂给节奏闸；剩 0 且未到重置时刻时，loader **一个字节都不发**，直接返回合成的 key 级 429（body 含 `free-models-per-day`）让 magpie 换账号。

并发安全：`take()` 的占位是**同步完成**的（JS 单线程原子），之后才 `await` 睡眠，所以并发调用方按调用顺序排在一条时间轴上，窗口内放行数严格不超配额。429 后 `refund()` 把刚占的配额退回，失败不吃自己的额度。

```js
import { createPacer } from "./src/pacing.mjs"
const pacer = createPacer({ requestIntervalMs: 800, freeRpmLimit: 20 })
const ticket = await pacer.take(key)  // { allowed, waitMs } 或 { allowed:false, reason:"daily-exhausted" }
pacer.refund(key)                     // 429 后归还配额
pacer.snapshot()                      // { used, remaining, perBucket, daily, counters }
```

## 行为说明

- 模型目录是公开数据，所有账号一致：10 分钟内跨账号共享一次 `/models` 拉取，每个账号仍单独探测 `/key` 以及时发现失效 key。这样 50 账号刷新时不再产生 50×(1 次 `/key` + 最多 20 页 `/models`) 请求。
- `magpie accounts import openrouter-live <file> --yes` 可直接导入；重复导入同一 email 是幂等更新（settle 按 `metadata.email` 认账号）。

## 测试

```sh
npm test          # node --test（64 个测试全过）
bun test .        # bun（本机 magpie 自带 bun 亦可）
```

单元测试不访问 OpenRouter（import 失败路径用 mock fetch）。

## 更新日志

- **0.6.1**（2026-11-27）⚠ 严重修复
  - **修复：usage 钩子不再改写账号记录。** 之前为了给面板供数据，`pushSnapshotToOptions()` 调用 `client.auth.set` 并传入不完整的 body —— 而 `client.auth.set` 的 body 就是**整条账号记录**，于是 magpie 用它整体替换，把该账号的 `key` 抹掉。
    实测损失：连续两次 `magpie quota refresh` 后，带合法 key 的账号 **58 → 55**，GUI 里账号退化成 `Signed in (hash)` + `OpenRouter has no key for this account`。
  - `rememberName()` 同样改为 no-op（理由相同）。账号显示名统一交给 magpie 官方的 `magpie accounts alias`（写 `providers.json` 的 `accountNames`，完全不碰账号记录）。
  - **不变量**：插件永不写账号记录。面板数据只走 `panel/pool-state.js`。
  - 测试同步改为断言「usage 不得调用 auth.set」（`saved.length === 0`）。
- **0.6.0**（2026-11-27）
  - **模块化重构**：`index.mjs` 16KB → 3.4KB（只做装配），钩子拆到 `src/hooks/`（config / options / import / loader / usage / models / poolstate），常量与静态表在 `src/context.mjs`；行为零变化
  - **请求节奏控制**（`src/pacing.mjs`）：每 key 最小间隔、免费模型 RPM 滑动窗口（默认 20/min）、日额度耗尽短路（`dailyGuard`）
  - **GUI 面板**（`panel/`，slot: provider）：账号池概览 + 每账号额度进度条 + failover 选项编辑。面板无网络，数据由插件写入 `panel/pool-state.js`
  - 全量测试 **64 passed**

- **未发布 · 请求节奏控制**（2026-11-27）
  - 新增 `src/pacing.mjs`：`createPacer()` → `{ take, refund, noteUsage, snapshot }`，三件事各自独立可关
  - 最小请求间隔 `requestIntervalMs`（默认 0 = 不延迟，保持原行为）
  - 免费模型分钟配额滑动窗口 `freeRpmLimit`（默认 20，按 key 各算；`rpmScope=global` 可改成全局共用）
  - 日额度短路 `dailyGuard`（默认开）：读 `/key` 的 `free_model_daily_requests` 剩余额度，剩 0 时 loader 直接返回合成 key 级 429、**不发上游请求**，省一次必然失败的调用
  - loader 接线：请求前 `pacer.take(key)`、429 后 `pacer.refund(key)`；`auth.usage` 每次读 `/key` 顺带喂日额度快照
  - GUI 选项补 `requestIntervalMs` / `freeRpmLimit` / `dailyGuard` 三个开关的中文说明
  - 新增 `src/pacing.test.mjs`（11 例：默认零延迟、间隔闸、滑动窗口、日额度短路、重置恢复、refund、snapshot、并发占位、全局作用域、loader 接线），全量 **64 passed**
- **未发布 · 模块化重构**（2026-11-27）
  - `index.mjs` 从 16KB 集中式拆成 **装配入口 2.6KB + `src/` 分层**（`src/context.mjs` 与 6 个 `src/hooks/*.mjs`），钩子实现与声明分离，改一块只看一个文件
  - 常量/静态表统一到 `src/context.mjs`：`PROVIDER`、`BASE`、`CATALOG_TTL`、`FREE_MODELS`、`DEAD_MODELS`、`HEALTHY_MODELS`、导入正则与超时；`failover.mjs` 改为从 context 取 `DEAD_MODELS` 并原样再导出（老 `import ... from "./failover.mjs"` 调用点不受影响）
  - **行为零变化**：导出契约仍是 `OpenRouterPlugin` + `_internal` 两个符号，钩子形状、日志、缓存语义完全一致；全量 `53 passed`（含 failover 21 例）
  - `package.json` 的 `files` 加 `src`（否则发布包缺 hook 文件，安装即崩）
- **0.5.0**（2026-11-27）
  - 补 `magpie.name = "OpenRouter"`（此前 GUI 里 provider 名为空）
  - 补 `optionsExample`：`fallbackToHealthy` / `healthyModelsOnly` / `freeOnly` / `providerSort` 四个开关的中文说明
  - 补 `repository` / `homepage` / `files`（含 `panel`）
  - 新增 `panel/`（账号池面板 + 一键刷新）：代码完成，**magpie 未加载本地目录 spec 的 panels**，已从 `package.json` 移除声明，详见 [`panel/README.md`](panel/README.md)
- **0.4.0**（2026-11-27）
  - 新增**双维度 429 failover**（`failover.mjs`）：429 响应按 body 特征分类——`free-models-per-day` 判为 key 级（日额度用尽，交 magpie 换账号）、`temporarily rate-limited upstream` 判为模型级（上游限流，插件自动换健康模型重试）
  - 模型健康状态跟踪：模型级 429 后冷却 60s（或按 `retry-after` / `x-ratelimit-reset`），期间不选；冷却中的模型自动跳过
  - `options.fallbackToHealthy`：请求点名已知全灭模型（`ling-3.2-flash`、`gemma-4-*`）时直接先改投健康免费模型，省一次必 429 的请求（默认关）
  - `options.healthyModelsOnly`：模型列表只暴露 9 个实测健康零价模型（默认关）
  - 429 分类计数与 failover 日志（事件/原因/切换目标）暴露在 provider 诊断接口
  - 新增 `failover.test.mjs`（21 用例），全量 53 个测试通过
- **0.3.2**（2026-11-26）
  - 静态兜底模型目录按线上实测刷新：7 个 `:free` → **12 个零价文本模型**（新增 `openrouter/free`、`nemotron-3-ultra-550b-a55b:free`、`nemotron-3-nano-omni-30b-a3b-reasoning:free`、`particle-ai/particle-1:free`、`recursive/flint-v1.0:free`）
  - 新增 `options.freeOnly`：模型列表只列免费号真正可调用的零价模型（默认关闭）
  - README 补齐「积分 / 余额」语义：$100 是 key 消费上限（guardrail），不是余额；免费号 `total_credits = 0`，付费模型 402
- **0.3.1**（2026-11-26）
  - 修复批量账号 quota 拉取超时（`context deadline exceeded`）：全局并发闸（3）+ 0–300ms 抖动 + 8s 超时 + 429/5xx 指数退避重试（500/1500/3000ms）
  - usage 结果跨账号缓存：成功 10 分钟、失败 60 秒；瞬时失败保留上次成功快照标 `stale`
  - 砍掉正常路径的 `/credits` 探测（免费层无意义），每账号请求数减半
- **0.3.0**（2026-11-26）
  - 导入验证后把 `limit`/`limit_remaining`/`usage`/`free_tier`/`free_daily_limit`/`label` 快照进账号 metadata
  - 验证请求 429/5xx 自动重试（500ms、1500ms）；401/403 的失败原因带上 OpenRouter 返回的原始错误信息
  - 静态兜底模型目录从 1 个（`openrouter/auto`）扩到 8 个（auto + 7 个真实 `:free` 模型）
  - 免费账号无信用余额时，quota 余额回退显示 key 的 `limit_remaining`
- **0.2.0**：修复 import schema——成功项返回顶层 `key`（旧版 `{auth:{key}}` 全部被 magpie 丢弃，报 "gave nothing to keep"）；`metadata.email` 作为 settle() 身份防重复导入；动态模型目录 + 10 分钟跨账号缓存；Decisions API 路由
- **0.1.0**：初始版本（基于 biyan113/magpie-openrouter）
