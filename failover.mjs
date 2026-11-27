// failover.mjs — 双维度 429 failover 的核心：429 分类识别、模型 cooldown、
// 统计计数与 failover 日志。
//
// 两条 429 语义（实测矩阵 dual_failover_matrix.json 归纳）：
//   1. key 级：body 含 "free-models-per-day"（该 key 当日 50 次免费额度用尽），
//      响应头带 x-ratelimit-limit/remaining/reset（UTC 0 点重置）。换 key 立刻解决。
//      插件拿不到其他账号的 key（magpie 插件 API：getAuth/loader 只能看到当前账号，
//      client.auth 只有 set/remove），key 级失利交给 magpie 收尾：magpie 收到 429
//      ("rate limited") 会把该账号 rest 到重置时间，然后在同 provider 的其他账号里
//      换一个有额度的再发（网关日志：`(rate limited: not asked again before ...)`）。
//   2. 模型级：body 含 "temporarily rate-limited upstream"（上游供应商限流），
//      换 key 无效，必须换模型。这是插件自己处理的维度。

import { DEAD_MODELS, PROVIDER } from "./src/context.mjs"

// DEAD_MODELS 的事实来源已上移到 src/context.mjs（重构后统一常量表）；这里原样再导出，
// 让 `import { DEAD_MODELS } from "./failover.mjs"` 的老调用点继续可用。
export { DEAD_MODELS, PROVIDER }

// 模型级 429 后的默认 cooldown（秒）；优先用响应里的 retry-after / x-ratelimit-reset。
export const MODEL_COOLDOWN_MS = 60 * 1000
// key 级 429 无响应头时的兜底：rest 到次日 UTC 0 点（OpenRouter 免费额度 UTC 重置）。
export const KEY_RESET_MS = 24 * 60 * 60 * 1000
// "其他" 类 429 的单次同模型重试背压上限。
export const OTHER_RETRY_MAX = 2
export const OTHER_RETRY_DELAY_MS = 500

const keyPrefix = (n) => `key-${String(n).padStart(2, "0")}`

// UTC 零点（下一次）的 epoch ms。
export function nextUtcMidnight(now = Date.now()) {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

// classify429 把一段 429 body 文本归到三类：
//   key   -> 该 key 的配额/额度用尽，换 key 有效
//   model -> 上游供应商限流（模型级），换 key 无效，要换模型
//   other -> 无法归类的 429（如突发 provider 限流、负载），同模型退避重试
export function classify429(text, headers) {
  const t = String(text ?? "")
  const header = (name) => {
    try {
      const h = new Headers(headers)
      return h.get(name) ?? ""
    } catch {
      return ""
    }
  }
  const hasResetHeader = /x-ratelimit-(limit|remaining|reset)/i.test(
    [header("x-ratelimit-limit"), header("x-ratelimit-remaining"), header("x-ratelimit-reset")].join(" "),
  )

  if (t.includes("free-models-per-day")) {
    return { kind: "key", limit: "free-models-per-day", hasResetHeader }
  }
  if (t.includes("temporarily rate-limited upstream")) {
    return { kind: "model", upstream: true, hasResetHeader }
  }
  if (t.includes("Provider returned error") && /rate[- ]limit|temporar/i.test(t)) {
    // Provider returned error 的 raw 里带了上游限流字样
    return { kind: "model", upstream: true, hasResetHeader }
  }
  if (t.includes("Rate limit exceeded")) {
    // 其他 "Rate limit exceeded: <limit>"（非 free-models-per-day），保守按 key 级。
    return { kind: "key", hasResetHeader }
  }
  return { kind: "other", hasResetHeader }
}

// readRetryAfter 解析响应头里的重试时刻：
//   retry-after: <秒> | <HTTP-date>
//   x-ratelimit-reset: <epoch ms>（OpenRouter 免费额度重置时刻）
// 解析失败返回 undefined。
export function readRetryAfter(res) {
  if (!res || typeof res.headers?.get !== "function") return undefined
  const ra = res.headers.get("retry-after")
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs) && secs >= 0) return Date.now() + secs * 1000
    const at = Date.parse(ra)
    if (Number.isFinite(at) && at > 0) return at
  }
  const reset = res.headers.get("x-ratelimit-reset")
  if (reset) {
    const ms = Number(reset)
    if (Number.isFinite(ms) && ms > 1e11) return ms // epoch ms（1973+）
    // 兜底：当普通数字（例如秒）时按相对重试处理
    if (Number.isFinite(ms) && ms > 0 && ms < 86400) return Date.now() + ms * 1000
  }
  return undefined
}

// cooldownUntilMs 决定模型/key 的 rest 时刻，并封顶，避免一次 429 把模型 rest 死。
export function cooldownUntilMs(kind, retryAt, now = Date.now()) {
  const cap = kind === "key" ? KEY_RESET_MS : MODEL_COOLDOWN_MS
  if (retryAt !== undefined && Number.isFinite(retryAt)) {
    const span = Math.max(0, retryAt - now)
    // 响应头说的时刻可信，但防止一个离谱值把模型冷却几小时。
    if (span <= cap * 6) return Math.max(now + 1000, retryAt)
  }
  return Math.max(now + 1000, now + cap)
}

// parseModelFromRequest 从 init.body 取请求的 model id（换模型时要用）。
export function parseModelFromRequest(body) {
  if (typeof body !== "string" || !body) return ""
  try {
    const json = JSON.parse(body)
    return typeof json?.model === "string" ? json.model : ""
  } catch {
    return ""
  }
}

// withModel 把 init.body 里的 model 换成另一个 id（尽量保序，行为等同原 JSON）。
export function withModel(body, model) {
  if (typeof body !== "string" || !body || !model) return body
  try {
    const json = JSON.parse(body)
    if (typeof json !== "object" || Array.isArray(json)) return body
    if (json.model === model) return body
    return JSON.stringify({ ...json, model })
  } catch {
    return body
  }
}

// ---- 模型健康状态（进程内内存） ----
const modelCooldown = new Map() // model -> until(ms)

export function isModelCooldown(model, now = Date.now()) {
  if (!model || typeof model !== "string") return false
  const until = modelCooldown.get(model)
  if (until === undefined) return false
  if (until <= now) {
    modelCooldown.delete(model)
    return false
  }
  return true
}

export function markModelCooldown(model, untilMs, now = Date.now()) {
  if (!model || typeof model !== "string") return
  if (!(untilMs > now)) return
  modelCooldown.set(model, untilMs)
}

export function clearModelCooldowns() {
  modelCooldown.clear()
}

// cooldownSnapshot 供诊断脚本 / 测试查看当前冷却中的模型。
export function cooldownSnapshot(now = Date.now()) {
  const out = {}
  for (const [model, until] of modelCooldown) {
    if (until > now) out[model] = new Date(until).toISOString()
  }
  return out
}

// ---- 统计（内存计数 + 近 20 条事件环） ----
const MAX_HISTORY = 20
export const stats = { key: 0, model: 0, other: 0, switched: 0, retried: 0, exhausted: 0, ok: 0 }
const history = [] // {at, kind, model, to, detail}

export function snapshotStats() {
  return { ...stats, history: [...history] }
}

function record(kind, detail) {
  if (history.length >= MAX_HISTORY) history.shift()
  history.push({ at: new Date().toISOString(), ...detail, kind })
}

export function _resetStatsForTests() {
  for (const k of Object.keys(stats)) stats[k] = 0
  history.length = 0
  modelCooldown.clear()
}

// ---- 日志 ----
// magpie 插件没有 "把计数暴露给 UI" 的钩子：auth.usage 是配额窗口语义，
// client 只有 auth/tui/app/config。可观测走两条路：
//   1. app.log 一行一条 failover 事件（GUI 日志可见）；
//   2. snapshotStats() 供 magpie 诊断或人肉查询。
export function logFailover(line, { client } = {}) {
  const text = `[${PROVIDER}] ${line}`
  try {
    console.log(`[plugin] ${text}`)
  } catch {
    // 宿主可能截断了 console
  }
  try {
    void client?.app?.log?.({ service: PROVIDER, message: line })
  } catch {
    // app.log 失败不影响请求
  }
}

// fmtFailover 生成统一格式的 failover 日志行。
export function fmtFailover({ event, model, to, reason, detail }) {
  const parts = [`failover: ${event}`]
  if (model) parts.push(`model=${model}`)
  if (reason) parts.push(`reason=${reason}`)
  if (to) parts.push(`-> model=${to}`)
  if (detail) parts.push(detail)
  return parts.join(" ")
}

// ---- 模型级 failover 检索 ----
// pickCandidate 从候选模型里挑下一个：跳过当前、冷却中的、已经试过的。
export function pickCandidate(candidates, currentModel, now = Date.now(), used = new Set(), extra = {}) {
  const cooldownMs = extra.cooldownMs ?? MODEL_COOLDOWN_MS
  for (const id of candidates) {
    if (!id || id === currentModel || used.has(id)) continue
    if (isModelCooldown(id, now)) continue
    return id
  }
  return ""
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// fetchWithFailover 是 loader.fetch 的核心：包一层 429 重试。
// 返回 429 时只消费 body 一次并重建 Response，非 429 原样透传。
//   doFetch   底层 fetch（通常就是全局 fetch）
//   url/init  已由 prepare() 重写过的请求
//   opts: {
//     key,         当前账号 key（仅用于日志标识）
//     candidates,  模型级 failover 的候选模型表（不含路由器）
//     fallbackToHealthy,  请求点名死模型时直接改投健康模型
//     healthyModelsOnly,  门口过滤（列表层），请求层也尊重健康集合
//     maxRetries, 总重试次数上限（默认 3：模型切换 ≤1 次 + 同模型退避补足）
//     modelCooldownMs,    模型级 cooldown 时长覆盖
//     client,     用于 app.log
//   }
export async function fetchWithFailover(doFetch, url, init, opts = {}) {
  const maxAttempts = 1 + Math.max(0, Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3)
  const candidates = Array.isArray(opts.candidates) ? opts.candidates.filter(Boolean) : []
  const cooldownMs = Number.isFinite(opts.modelCooldownMs) && opts.modelCooldownMs > 0 ? opts.modelCooldownMs : MODEL_COOLDOWN_MS
  const fallback = opts.fallbackToHealthy === true
  // 允许调用方注入死模型集合（默认用内置的 DEAD_MODELS，当前为空 —— 见 context.mjs 注释）。
  // 注入能力主要给测试用：内置列表清空后，仍能验证「改投」这条路径。
  const deadSet = opts.deadModels instanceof Set ? opts.deadModels : DEAD_MODELS
  const client = opts.client
  const bare = { ...init, headers: new Headers(init?.headers) }
  bare.headers.delete("content-length")
  const requestModel = parseModelFromRequest(bare.body)
  const log = (line) => logFailover(line, { client })

  let current = requestModel
  let init0 = bare
  // 请求点名了全灭模型：先别发，直接改投健康模型（省一次必 429 的请求）。
  if (fallback && current && deadSet.has(current)) {
    const next = pickCandidate(candidates, current, Date.now(), new Set(), { cooldownMs })
    if (next) {
      const body = withModel(bare.body, next)
      const headers = new Headers(bare.headers)
      headers.delete("content-length")
      init0 = { ...bare, headers, body }
      stats.switched++
      record("model", { model: current, to: next, detail: "known-dead → healthy (fallbackToHealthy)" })
      log(fmtFailover({ event: "model", model: current, reason: "known-dead", to: next }))
      current = next
    }
  }

  let res
  let modelSwitched = false
  const used = new Set()
  for (let attempt = 0; ; attempt++) {
    res = await doFetch(url, init0)
    if (res?.status !== 429) {
      stats.ok++
      return res
    }
    // 只有 429 才消费 body；读到一次文本后重建一个等价 Response 交给调用方。
    let text = ""
    try {
      text = await res.text()
    } catch {
      text = ""
    }
    const rebuilt = () =>
      new Response(text, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) })
    const info = classify429(text, res.headers)
    const retryAt = readRetryAfter(res)
    const now = Date.now()

    if (info.kind === "key") {
      // key 级：插件拿不到其他账号的 key，无法在插件内轮换。
      // 返回 429 让 magpie 收尾：magpie 会把该账号 rest 到重置时间，
      // 然后在同 provider 的其他账号里挑下一个有额度的重发。
      stats.key++
      const until = cooldownUntilMs("key", retryAt, now)
      record("key", { model: current, until: new Date(until).toISOString() })
      log(fmtFailover({ event: "key", model: current, reason: "exhausted", detail: `until ${new Date(until).toISOString()}` }))
      return rebuilt()
    }

    if (info.kind === "model") {
      stats.model++
      // 冷却这个模型（60s 或 retry-after 告知的时刻）
      const until = cooldownUntilMs("model", retryAt, now)
      if (current) markModelCooldown(current, until, now)
      record("model", { model: current, reason: "upstream", until: new Date(until).toISOString() })
      if (attempt >= maxAttempts - 1 || modelSwitched) return rebuilt()
      const next = pickCandidate(candidates, current, now, used, { cooldownMs })
      if (!next) {
        log(fmtFailover({ event: "model", model: current, reason: "upstream", detail: "no healthy alternative" }))
        return rebuilt()
      }
      used.add(current)
      const body = withModel(init0.body, next)
      const headers = new Headers(init0.headers)
      headers.delete("content-length")
      init0 = { ...init0, headers, body }
      stats.switched++
      modelSwitched = true
      log(fmtFailover({ event: "model", model: current, reason: "upstream", to: next }))
      current = next
      continue
    }

    // other：无法归类的 429，同模型短退避重试（预算内）。
    stats.other++
    record("other", { model: current, retried: true })
    if (attempt >= maxAttempts - 1) return rebuilt()
    await sleep(OTHER_RETRY_DELAY_MS)
  }
}

export const _failoverInternals = {
  DEAD_MODELS,
  MODEL_COOLDOWN_MS,
  KEY_RESET_MS,
  OTHER_RETRY_MAX,
  OTHER_RETRY_DELAY_MS,
  nextUtcMidnight,
  history,
}