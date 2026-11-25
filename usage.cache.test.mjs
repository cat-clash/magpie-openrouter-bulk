import assert from "node:assert/strict"
import test from "node:test"
import { _usageInternals, clearUsageCache, readKeyUsage, readUsageCached } from "./usage.mjs"

const { USAGE_CONCURRENCY, USAGE_TTL, USAGE_FAIL_TTL, usageCache } = _usageInternals

function json(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body
    },
  }
}

const KEY_DATA = { data: { name: "bulk", is_free_tier: true, limit: 100, limit_remaining: 100, free_model_daily_requests: { used: 0, limit: 50 } } }

test("readKeyUsage probes only /key (no /credits) and still derives balance", async () => {
  const calls = []
  const report = await readKeyUsage(async (url) => {
    calls.push(String(url))
    return json(KEY_DATA)
  }, "sk-or-v1-keyonly")
  assert.deepEqual(calls.map((u) => u.split("/").pop()), ["key"])
  assert.equal(report.balance, "$100.00")
  assert.equal(report.windows.some((w) => w.name === "credits"), false)
  assert.ok(report.windows.some((w) => w.name === "free models"))
})

test("readKeyUsage retries on 429/5xx with bounded attempts and backoff", async () => {
  let attempts = 0
  const delays = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => {
    if (ms === 500 || ms === 1500 || ms === 3000) {
      delays.push(ms)
      return realSetTimeout(fn, 0)
    }
    return realSetTimeout(fn, ms)
  }
  try {
    const report = await readKeyUsage(async () => {
      attempts++
      if (attempts < 3) return json({}, 429)
      return json(KEY_DATA)
    }, "sk-or-v1-retry")
    assert.equal(attempts, 3, "429 twice then success")
    assert.deepEqual(delays, [500, 1500])
    assert.equal(report.balance, "$100.00")

    attempts = 0
    const failed = await readKeyUsage(async () => {
      attempts++
      return json({}, 503)
    }, "sk-or-v1-always503")
    assert.equal(attempts, 4, "initial + 3 retries then give up")
    assert.equal(failed.error, "OpenRouter answered 503")
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test("usage cached across accounts within 10 minutes; second refresh makes no API call", async () => {
  clearUsageCache()
  let calls = 0
  const doFetch = async () => {
    calls++
    return json(KEY_DATA)
  }
  const first = await readUsageCached(doFetch, "sk-or-v1-cached")
  assert.equal(first.balance, "$100.00")
  assert.equal(calls, 1)
  const second = await readUsageCached(doFetch, "sk-or-v1-cached")
  assert.equal(calls, 1, "no new API call on cache hit")
  assert.deepEqual(second, first)
  assert.equal(usageCache.get("sk-or-v1-cached").stale, false)
  clearUsageCache()
})

test("concurrent refreshes of many keys never exceed the global concurrency cap", async () => {
  clearUsageCache()
  let active = 0
  let peak = 0
  const doFetch = async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 30))
    active--
    return json(KEY_DATA)
  }
  // 固定抖动为 0，让 12 个请求同时抢闸，才能精确验证上限。
  const realRandom = Math.random
  Math.random = () => 0
  try {
    const keys = Array.from({ length: 12 }, (_, i) => `sk-or-v1-cap${i}`)
    await Promise.all(keys.map((k) => readUsageCached(doFetch, k)))
  } finally {
    Math.random = realRandom
  }
  assert.ok(peak <= USAGE_CONCURRENCY, `peak ${peak} <= ${USAGE_CONCURRENCY}`)
  assert.equal(peak, USAGE_CONCURRENCY, "cap actually used")
  clearUsageCache()
})

test("in-flight requests for the same key are deduplicated", async () => {
  clearUsageCache()
  let calls = 0
  const doFetch = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 5))
    return json(KEY_DATA)
  }
  const [a, b] = await Promise.all([
    readUsageCached(doFetch, "sk-or-v1-dedupe"),
    readUsageCached(doFetch, "sk-or-v1-dedupe"),
  ])
  assert.equal(calls, 1, "one API call for two simultaneous refreshes")
  assert.deepEqual(a, b)
  clearUsageCache()
})

test("transient failure keeps last successful snapshot as stale, cached 60s", async () => {
  clearUsageCache()
  let fail = false
  const doFetch = async () => (fail ? json({}, 500) : json(KEY_DATA))
  const good = await readUsageCached(doFetch, "sk-or-v1-stale")
  assert.equal(good.balance, "$100.00")
  fail = true
  // 用真实短退避：500+1500+3000ms 太久，这里直接推进缓存时间以外的方式验证
  // ——把 hit 的 at 改成刚过期，让 readUsageCached 重新拉取并触发失败兜底。
  const hit = usageCache.get("sk-or-v1-stale")
  hit.at = Date.now() - USAGE_TTL - 1
  // 加速退避：把 500/1500/3000ms 的等待换成 0ms（仅本测试内）。
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, ms === 500 || ms === 1500 || ms === 3000 ? 0 : ms)
  let stale
  try {
    stale = await readUsageCached(doFetch, "sk-or-v1-stale")
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  assert.equal(stale.stale, true, "marked stale")
  assert.equal(stale.balance, "$100.00", "keeps last successful value")
  assert.ok(stale.asOf, "carries timestamp")
  assert.equal(usageCache.get("sk-or-v1-stale").stale, true)
  // 失败缓存 60s：后续调用直接返回 stale，不再打 API（fail fetch 若再打会重试 5s）
  const again = await readUsageCached(doFetch, "sk-or-v1-stale")
  assert.equal(again.stale, true)
  clearUsageCache()
})

test("expired key is reported immediately without stale masking", async () => {
  clearUsageCache()
  const denied = await readUsageCached(async () => json({}, 401), "sk-or-v1-expired")
  assert.equal(denied.signIn, "expired")
  assert.equal(denied.stale, undefined)
  clearUsageCache()
})

test("internals expose the documented caps", () => {
  assert.equal(USAGE_CONCURRENCY, 3)
  assert.equal(_usageInternals.USAGE_TIMEOUT, 8000)
  assert.deepEqual(_usageInternals.USAGE_RETRY_DELAYS, [500, 1500, 3000])
  assert.equal(USAGE_TTL, 600000)
  assert.equal(USAGE_FAIL_TTL, 60000)
})
