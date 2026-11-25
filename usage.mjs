import { BASE } from "./catalog.mjs"

export function money(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined
  const abs = Math.abs(n)
  const digits = abs !== 0 && abs < 0.01 ? 4 : 2
  return `${n < 0 ? "-" : ""}$${abs.toFixed(digits)}`
}

// windowReset is the UTC instant a daily, weekly (Monday) or monthly limit rolls over.
export function windowReset(kind, now = Date.now()) {
  const d = new Date(now)
  if (kind === "daily") {
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    return { resetsAt: new Date(next).toISOString(), span: 86400 }
  }
  if (kind === "weekly") {
    const sinceMonday = (d.getUTCDay() + 6) % 7
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday)
    return { resetsAt: new Date(start + 7 * 86400000).toISOString(), span: 7 * 86400 }
  }
  if (kind === "monthly") {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    return { resetsAt: new Date(next).toISOString(), span: Math.round((next - start) / 1000) }
  }
  return {}
}

function accountName(data) {
  const name = typeof data?.name === "string" ? data.name.trim() : ""
  if (!name || name.startsWith("sk-or-")) return undefined
  return name
}

function percent(used, limit) {
  if (typeof used !== "number" || typeof limit !== "number" || !(limit > 0)) return undefined
  return (used / limit) * 100
}

// usageFromPayload turns GET /key and, when present, GET /credits into magpie's usage object.
export function usageFromPayload(data, credits, now = Date.now()) {
  if (!data || typeof data !== "object") return { error: "OpenRouter returned no key info", windows: [] }
  const windows = []

  if (credits && typeof credits.total_credits === "number" && credits.total_credits > 0) {
    const used = Number(credits.total_usage) || 0
    windows.push({
      name: "credits",
      used: percent(used, credits.total_credits),
      amount: used,
      limit: credits.total_credits,
      unit: "credits",
      display: `${money(used)} / ${money(credits.total_credits)}`,
    })
  }

  if (typeof data.limit === "number" && data.limit > 0) {
    const remaining = typeof data.limit_remaining === "number" ? data.limit_remaining : 0
    const used = Math.max(0, data.limit - remaining)
    const reset = windowReset(data.limit_reset, now)
    windows.push({
      name: data.limit_reset ? `key limit · ${data.limit_reset}` : "key limit",
      used: percent(used, data.limit),
      amount: used,
      limit: data.limit,
      unit: "credits",
      display: `${money(used)} / ${money(data.limit)}`,
      ...reset,
    })
  }

  const budget = data.effective_budget
  if (budget && typeof budget.limit_usd === "number" && budget.limit_usd > 0 && budget.scope !== "key_limit") {
    const reset = budget.resets_at
      ? { resetsAt: budget.resets_at, ...windowReset(budget.reset_interval, now) }
      : windowReset(budget.reset_interval, now)
    if (budget.resets_at) reset.resetsAt = budget.resets_at
    windows.push({
      name: budget.scope ? `budget · ${budget.scope}` : "budget",
      used: percent(budget.spend_usd, budget.limit_usd),
      amount: budget.spend_usd,
      limit: budget.limit_usd,
      unit: "credits",
      display: `${money(budget.spend_usd)} / ${money(budget.limit_usd)}`,
      ...reset,
    })
  }

  const free = data.free_model_daily_requests
  if (free && typeof free.limit === "number" && free.limit > 0) {
    windows.push({
      name: "free models",
      used: percent(free.used, free.limit),
      amount: free.used ?? 0,
      limit: free.limit,
      unit: "requests",
      display: `${free.used ?? 0} / ${free.limit} free requests`,
      model: ":free",
      ...windowReset("daily", now),
    })
  }

  if (typeof data.usage_daily === "number") {
    windows.push({
      name: "today",
      display: `${money(data.usage_daily)} today`,
      amount: data.usage_daily,
      unit: "credits",
      aside: true,
      span: 86400,
    })
  }

  const creditsLeft =
    credits && typeof credits.total_credits === "number"
      ? credits.total_credits - (Number(credits.total_usage) || 0)
      : undefined
  // Free-tier keys carry no credit balance; their spendable amount is the
  // key's own remaining limit, so report that as the balance when credits
  // are empty (registrar keys: $100 limit, limit_remaining 100).
  const left =
    creditsLeft > 0
      ? creditsLeft
      : typeof data.limit === "number" && data.limit > 0 && typeof data.limit_remaining === "number"
        ? data.limit_remaining
        : creditsLeft

  return {
    plan: data.is_free_tier ? "Free" : "Paid",
    ...(accountName(data) ? { user: accountName(data) } : {}),
    ...(left !== undefined ? { balance: money(left) } : {}),
    windows,
  }
}

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

// ---- 批量账号下的配额读取 ----------------------------------------------
// 39 把 key × 每把 /key + /credits（78 请求）在 magpie 网关并发 8 路 +
// GUI 每次刷新全量重拉时，瞬间打到同一出口 IP（代理 127.0.0.1:7897），
// 触发 OpenRouter per-IP 突发限流：部分请求挂到网关 context deadline。
// 修复：全局并发闸（3）+ 0-300ms 抖动 + 8s 超时 + 429/5xx 指数退避重试
// + 成功缓存 10 分钟 / 失败缓存 60 秒 + 正常路径砍掉 /credits。
const USAGE_CONCURRENCY = 3
const USAGE_TIMEOUT = 8000
const USAGE_RETRY_DELAYS = [500, 1500, 3000]
const USAGE_TTL = 10 * 60 * 1000
const USAGE_FAIL_TTL = 60 * 1000
const USAGE_JITTER = 300

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 跨账号信号量：magpie 对每个账号各调一次 auth.usage，并发上限由插件自己守。
let usageActive = 0
const usageWaiters = []

async function withUsageSlot(fn) {
  if (usageActive >= USAGE_CONCURRENCY) {
    await new Promise((resolve) => usageWaiters.push(resolve))
  }
  usageActive++
  try {
    return await fn()
  } finally {
    usageActive--
    const next = usageWaiters.shift()
    if (next) next()
  }
}

// usageCache: key -> { at, report, stale }。成功缓存 10 分钟；失败缓存 60 秒
// 并保留上次成功快照（stale），避免死账号每次 GUI 刷新都重试。
const usageCache = new Map()
const usageInflight = new Map()

function isFresh(entry, now) {
  if (!entry) return false
  return now - entry.at < (entry.stale ? USAGE_FAIL_TTL : USAGE_TTL)
}

export async function readUsageCached(doFetch, key, now = Date.now()) {
  if (!key) return { error: "OpenRouter has no key for this account", windows: [] }
  const hit = usageCache.get(key)
  if (isFresh(hit, now)) return hit.report

  // 同一把 key 的并发请求合流，避免 GUI 连刷时重复打 API。
  const pending = usageInflight.get(key)
  if (pending) return pending

  const task = withUsageSlot(async () => {
    await sleep(Math.floor(Math.random() * USAGE_JITTER)) // 0-300ms 抖动，打散突发
    const report = await readKeyUsage(doFetch, key, Date.now())
    const expired = report?.signIn === "expired"
    const failed = typeof report?.error === "string"
    if (!failed && !expired) {
      usageCache.set(key, { at: Date.now(), report, stale: false })
    } else if (expired) {
      // 401：账号真失效，短缓存避免每次刷新都打。
      usageCache.set(key, { at: Date.now(), report, stale: true })
    } else if (hit && !hit.stale) {
      // 瞬时失败但有上次成功快照：保留旧值并标 stale，60 秒内不再重试。
      const staleReport = { ...hit.report, stale: true, asOf: new Date(hit.at).toISOString() }
      usageCache.set(key, { at: Date.now(), report: staleReport, stale: true })
      return staleReport
    } else {
      usageCache.set(key, { at: Date.now(), report, stale: true })
    }
    return report
  })
  usageInflight.set(key, task)
  try {
    return await task
  } finally {
    usageInflight.delete(key)
  }
}

export function clearUsageCache() {
  usageCache.clear()
  usageInflight.clear()
}

// readKeyUsage 是运行时路径：只打 GET /key，带超时与退避重试。
// 免费层 key 的 /credits 无意义（余额 = $100 key limit，已在 /key 里），
// 砍掉后每账号请求数减半。
export async function readKeyUsage(doFetch, key, now = Date.now()) {
  if (!key) return { error: "OpenRouter has no key for this account", windows: [] }
  const headers = { accept: "application/json", authorization: `Bearer ${key}` }
  const keyBody = await fetchKeyWithRetry(doFetch, headers)
  if (keyBody.signIn) return { error: "OpenRouter rejected this key. Sign in again.", windows: [], signIn: "expired" }
  if (!keyBody.ok) return { error: `OpenRouter answered ${keyBody.status}`, windows: [] }
  return usageFromPayload(keyBody.data, undefined, now)
}

// fetchKeyWithRetry 给 GET /key 加 8s 超时与 429/5xx/超时 指数退避重试。
async function fetchKeyWithRetry(doFetch, headers) {
  let last = { ok: false, status: 0 }
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), USAGE_TIMEOUT)
    try {
      const res = await doFetch(`${BASE}/key`, { headers, signal: ctl.signal })
      if (res.status === 401 || res.status === 403) return { signIn: "expired", status: res.status }
      if (res.ok) return { ok: true, status: res.status, data: (await readJson(res))?.data }
      last = { ok: false, status: res.status }
    } catch {
      last = { ok: false, status: 0 }
    } finally {
      clearTimeout(timer)
    }
    const transient = last.status === 429 || last.status >= 500 || last.status === 0
    if (!transient || attempt >= USAGE_RETRY_DELAYS.length) return last
    await sleep(USAGE_RETRY_DELAYS[attempt])
  }
}

// readUsage 保留旧的两端点行为（/key + 可选 /credits），供直接调用者兼容；
// 运行时（magpie 批量 usage）已改用 readUsageCached -> readKeyUsage。
export async function readUsage(doFetch, key, now = Date.now()) {
  if (!key) return { error: "OpenRouter has no key for this account", windows: [] }
  const headers = { accept: "application/json", authorization: `Bearer ${key}` }
  const keyRes = await doFetch(`${BASE}/key`, { headers })
  if (keyRes.status === 401) {
    return { error: "OpenRouter rejected this key. Sign in again.", windows: [], signIn: "expired" }
  }
  if (!keyRes.ok) return { error: `OpenRouter answered ${keyRes.status}`, windows: [] }
  const keyBody = await readJson(keyRes)

  let credits
  const creditsRes = await doFetch(`${BASE}/credits`, { headers })
  if (creditsRes.status === 401) {
    return { error: "OpenRouter rejected this key. Sign in again.", windows: [], signIn: "expired" }
  }
  if (creditsRes.ok) credits = (await readJson(creditsRes))?.data

  return usageFromPayload(keyBody?.data, credits, now)
}

export const _usageInternals = {
  USAGE_CONCURRENCY,
  USAGE_TIMEOUT,
  USAGE_RETRY_DELAYS,
  USAGE_TTL,
  USAGE_FAIL_TTL,
  usageCache,
  usageInflight,
}