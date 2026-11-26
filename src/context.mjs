// src/context.mjs — 全局常量与静态模型表（重构后唯一的「事实来源」）
//
// 这里只放数据和纯常量：provider 标识、端点、静态免费模型表、健康/死模型清单、
// 导入校验用的正则与超时。任何钩子都从这里取，避免同一份清单散落在多个文件里漂移。
//
// 依赖方向（单向，无环）：
//   catalog.mjs  ←  context.mjs  ←  hooks/*.mjs  ←  index.mjs
// failover.mjs 也从这里取 DEAD_MODELS 并**原样再导出**，保持 `import ... from "./failover.mjs"`
// 的老调用点（failover.test.mjs 等）继续可用。

import { BASE } from "../catalog.mjs"

export { BASE }

export const PROVIDER = "openrouter-live"
export const ICON = "https://cdn.simpleicons.org/openrouter"

// 模型目录对所有账号相同：每个账号各拉一次 /models（最多 21 页）在 50 账号池下是
// 上千次请求。共享一份目录 + 短 TTL，但仍逐个探测账号 key（吊销要立刻报出来）。
export const CATALOG_TTL = 10 * 60 * 1000

export const AUTO = {
  name: "OpenRouter Auto",
  limit: { context: 2000000, output: 8192 },
  tool_call: true,
}

// 2026-11-26 实测：模型级全灭（3 把 key 全 429 upstream）——任何 key 都调不通。
export const DEAD_MODELS = new Set([
  "inclusionai/ling-3.2-flash:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
])

// 2026-11-26 实测 3 把 key × 12 模型矩阵里能稳定 200 的零价模型（含 openrouter/free
// 路由器，但不含 openrouter/auto —— 它只是聊天路由名）。
export const HEALTHY_MODELS = [
  "baidu/ernie-5.5-flash-preview:free",
  "liquid/lfm-3-1.7b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "particle-ai/particle-1:free",
  "recursive/flint-v1.0:free",
  "openrouter/free",
]

// 离线兜底目录：`openrouter/auto` 加最后一次刷新（2026-11-26，737 模型 / 21 个 `:free` /
// 12 个可用的文本对话模型）时 OpenRouter 真在服务的零价模型。只要有一把 key 能连上
// OpenRouter，/models 的实时目录就整表替换它 —— 这份只在离线、首次刷新前、或全新安装
// 尚无 key 时起作用。
export const FREE_MODELS = {
  "openrouter/auto": AUTO,
  "baidu/ernie-5.5-flash-preview:free": { name: "Baidu: ERNIE-5.5-Flash-Preview (free)", limit: { context: 1024000, output: 921600 }, tool_call: true, reasoning: true, free: true },
  "google/gemma-4-26b-a4b-it:free": { name: "Google: Gemma 4 26B A4B (free)", limit: { context: 262144, output: 32768 }, tool_call: true, free: true },
  "google/gemma-4-31b-it:free": { name: "Google: Gemma 4 31B (free)", limit: { context: 262144, output: 32768 }, tool_call: true, free: true },
  "inclusionai/ling-3.2-flash:free": { name: "inclusionAI: Ling 3.2 Flash (free)", limit: { context: 1048576, output: 262144 }, tool_call: true, reasoning: true, free: true },
  "liquid/lfm-3-1.7b:free": { name: "LiquidAI: LFM3-1.7B (free)", limit: { context: 262144, output: 8192 }, tool_call: true, reasoning: true, free: true },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { name: "NVIDIA: Nemotron 3 Nano Omni (free)", limit: { context: 256000, output: 65536 }, tool_call: true, reasoning: true, free: true },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { name: "NVIDIA: Nemotron 3 Ultra (free)", limit: { context: 1000000, output: 65536 }, tool_call: true, reasoning: true, free: true },
  "nvidia/nemotron-3.5-lightning:free": { name: "NVIDIA: Nemotron 3.5 Lightning (free)", limit: { context: 1000000, output: 65536 }, tool_call: true, free: true },
  "nvidia/nemotron-3.5-super-vl:free": { name: "NVIDIA: Nemotron 3.5 Super VL (free)", limit: { context: 1000000, output: 131072 }, tool_call: true, free: true },
  "openrouter/free": { name: "Free Models Router", limit: { context: 200000 }, tool_call: true, free: true },
  "particle-ai/particle-1:free": { name: "Particle AI: Particle-1 (free)", limit: { context: 1048576, output: 131072 }, tool_call: true, reasoning: true, free: true },
  "recursive/flint-v1.0:free": { name: "Recursive: Flint (free)", limit: { context: 262144, output: 235929 }, tool_call: true, reasoning: true, free: true },
}

// 模型级 failover 的候选：健康的免费具体模型（排除两个路由器 —— 它们既不解 key 级
// 也不解模型级 429），排除实测全灭的模型。
export function failoverCandidates() {
  return Object.keys(FREE_MODELS).filter(
    (id) => FREE_MODELS[id].free === true && !id.startsWith("openrouter/") && !DEAD_MODELS.has(id),
  )
}

// ---- 批量导入（magpie auth.import 扩展点，单次 ≤100）----
export const KEY_RE = /^sk-or-[A-Za-z0-9_\-]+$/
export const MAX_IMPORT = 100

export const VERIFY_TIMEOUT = 15000
// 429 / 5xx 是瞬时的：两次重试（500ms、1500ms）后才判失败。
export const VERIFY_RETRY_DELAYS = [500, 1500]

export const shortId = (key) => `key-${key.slice(-6)}`
