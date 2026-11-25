import assert from "node:assert/strict"
import test from "node:test"
import { money, readUsage, usageFromPayload, windowReset } from "./usage.mjs"

const now = Date.parse("2026-10-18T15:00:00Z") // Sunday

test("windowReset uses UTC day, Monday week and calendar month", () => {
  assert.equal(windowReset("daily", now).resetsAt, "2026-10-19T00:00:00.000Z")
  assert.equal(windowReset("daily", now).span, 86400)
  assert.equal(windowReset("weekly", now).resetsAt, "2026-10-19T00:00:00.000Z")
  assert.equal(windowReset("weekly", now).span, 604800)
  const month = windowReset("monthly", now)
  assert.equal(month.resetsAt, "2026-11-01T00:00:00.000Z")
  assert.equal(month.span, 31 * 86400)
})

test("money keeps small credit balances readable", () => {
  assert.equal(money(12.4), "$12.40")
  assert.equal(money(0.0012), "$0.0012")
  assert.equal(money(-2), "-$2.00")
})

test("usageFromPayload reports credits, the key cap, free requests and today's spend", () => {
  const report = usageFromPayload(
    {
      name: "work",
      is_free_tier: false,
      limit: 100,
      limit_remaining: 74.5,
      limit_reset: "monthly",
      usage_daily: 1.25,
      effective_budget: {
        scope: "key_limit",
        limit_usd: 100,
        spend_usd: 25.5,
        reset_interval: "monthly",
      },
      free_model_daily_requests: { used: 20, limit: 1000, remaining: 980 },
    },
    { total_credits: 100.5, total_usage: 25.75 },
    now,
  )
  assert.equal(report.plan, "Paid")
  assert.equal(report.user, "work")
  assert.equal(report.balance, "$74.75")
  assert.deepEqual(
    report.windows.map((w) => w.name),
    ["credits", "key limit · monthly", "free models", "today"],
  )
  const key = report.windows[1]
  assert.equal(key.limit, 100)
  assert.equal(key.amount, 25.5)
  assert.equal(key.used, 25.5)
  assert.equal(key.resetsAt, "2026-11-01T00:00:00.000Z")
  const free = report.windows[2]
  assert.equal(free.model, ":free")
  assert.equal(free.used, 2)
  assert.equal(report.windows[3].aside, true)
})

test("a guardrail budget is its own window and a masked key name is not an account name", () => {
  const report = usageFromPayload(
    {
      name: "sk-or-v1-abcd",
      is_free_tier: true,
      limit: null,
      effective_budget: {
        scope: "member",
        limit_usd: 50,
        spend_usd: 40,
        reset_interval: "weekly",
        resets_at: "2026-10-19T00:00:00.000Z",
      },
      usage_daily: 0,
    },
    undefined,
    now,
  )
  assert.equal(report.plan, "Free")
  assert.equal(report.user, undefined)
  assert.equal(report.balance, undefined)
  const budget = report.windows.find((w) => w.name.startsWith("budget"))
  assert.equal(budget.used, 80)
  assert.equal(budget.resetsAt, "2026-10-19T00:00:00.000Z")
})

function json(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body
    },
  }
}

test("readUsage marks a rejected key and skips a credits endpoint the key cannot call", async () => {
  const denied = await readUsage(async () => json({ error: { message: "nope" } }, 401), "sk-or-v1-x")
  assert.equal(denied.signIn, "expired")

  const calls = []
  const report = await readUsage(async (url) => {
    calls.push(String(url))
    if (String(url).endsWith("/credits")) return json({ error: "management key required" }, 403)
    return json({
      data: { name: "solo", is_free_tier: true, limit: null, usage_daily: 0.5 },
    })
  }, "sk-or-v1-ok")
  assert.equal(report.user, "solo")
  assert.equal(report.balance, undefined)
  assert.equal(report.windows.some((w) => w.name === "credits"), false)
  assert.deepEqual(calls.map((u) => u.split("/").pop()), ["key", "credits"])
})
