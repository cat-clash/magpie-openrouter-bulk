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
