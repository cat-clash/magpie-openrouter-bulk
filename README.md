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
- GET `/api/v1/credits`：`total_credits` / `total_usage` → 账户信用余额。免费账号没有信用余额时，余额回退显示 key 的 `limit_remaining`（即 $100 限额剩余）
- `effective_budget` / `budgets`（org 管理的预算）非 `key_limit` scope 时单独一个「budget」窗口

## OpenRouter 官网调研要点

- **Key 格式**：`sk-or-v1-` + 64 位小写十六进制，共 73 字符
- **新账号 onboarding key**：默认 $100 信用限额，**180 天过期**（不是一年）
- **GET `/api/v1/key`**（Bearer key）：返回 `label`、`limit`、`limit_remaining`、`limit_reset`、`usage`、`usage_daily/weekly/monthly`、`is_free_tier`、`free_model_daily_requests{used,limit,remaining}`、`budgets`、`effective_budget`、`expires_at`
- **免费模型**：id 以 `:free` 结尾，prompt/completion 价格均为 0。平台限额：**20 请求/分钟**；每日请求数 = 累计充值 < $10 时 **50 次/天**，≥ $10 时 1000 次/天。`free_model_daily_requests` 只报每日计数
- **限流**：key 管理（POST/PATCH/DELETE `/keys`）默认 10,000 次/天；`GET /key`、`/credits`、`GET /keys` 有按 IP 的突发限额（无 `X-RateLimit-*` 头，429 时指数退避重试）
- **402/403 额度类错误**：`error.metadata.limit_source` 区分 `openrouter_key_limit` / `openrouter_credits` / in-flight 预算
- `GET /api/v1/models` 为公开端点（无需鉴权），支持 `limit` / `output_modalities` 参数与 `links.next` 分页

### 当前真实存在的文本 `:free` 模型（2026-11-26 实测，共 11 个）

| 模型 | 上下文 | 最大输出 | tools |
| --- | --- | --- | --- |
| `inclusionai/ling-3.2-flash:free` | 1,048,576 | 262,144 | ✓ |
| `baidu/ernie-5.5-flash-preview:free` | 1,024,000 | 921,600 | ✓ |
| `particle-ai/particle-1:free` | 1,048,576 | 131,072 | ✓ |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | 65,536 | ✓ |
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | 131,072 | ✓ |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 65,536 | ✓ |
| `recursive/flint-v1.0:free` | 262,144 | 235,929 | ✓ |
| `google/gemma-4-31b-it:free` | 262,144 | 32,768 | ✓ |
| `google/gemma-4-26b-a4b-it:free` | 262,144 | 32,768 | ✓ |
| `liquid/lfm-3-1.7b:free` | 262,144 | 8,192 | ✓ |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256,000 | 65,536 | ✓ |

插件静态兜底目录收录了其中 7 个（见 `index.mjs` 的 `FREE_MODELS`）；登录后以 `/models` 实时目录为准。

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

## 行为说明

- 模型目录是公开数据，所有账号一致：10 分钟内跨账号共享一次 `/models` 拉取，每个账号仍单独探测 `/key` 以及时发现失效 key。这样 50 账号刷新时不再产生 50×(1 次 `/key` + 最多 20 页 `/models`) 请求。
- `magpie accounts import openrouter-live <file> --yes` 可直接导入；重复导入同一 email 是幂等更新（settle 按 `metadata.email` 认账号）。

## 测试

```sh
npm test          # node --test（148 个断言全过）
bun test .        # bun（本机 magpie 自带 bun 亦可）
```

单元测试不访问 OpenRouter（import 失败路径用 mock fetch）。

## 更新日志

- **0.3.0**（2026-11-26）
  - 导入验证后把 `limit`/`limit_remaining`/`usage`/`free_tier`/`free_daily_limit`/`label` 快照进账号 metadata
  - 验证请求 429/5xx 自动重试（500ms、1500ms）；401/403 的失败原因带上 OpenRouter 返回的原始错误信息
  - 静态兜底模型目录从 1 个（`openrouter/auto`）扩到 8 个（auto + 7 个真实 `:free` 模型）
  - 免费账号无信用余额时，quota 余额回退显示 key 的 `limit_remaining`
- **0.2.0**：修复 import schema——成功项返回顶层 `key`（旧版 `{auth:{key}}` 全部被 magpie 丢弃，报 "gave nothing to keep"）；`metadata.email` 作为 settle() 身份防重复导入；动态模型目录 + 10 分钟跨账号缓存；Decisions API 路由
- **0.1.0**：初始版本（基于 biyan113/magpie-openrouter）
