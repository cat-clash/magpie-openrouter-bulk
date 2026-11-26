import assert from "node:assert/strict"
import test from "node:test"
import {
  classify429,
  readRetryAfter,
  cooldownUntilMs,
  parseModelFromRequest,
  withModel,
  pickCandidate,
  markModelCooldown,
  isModelCooldown,
  clearModelCooldowns,
  fetchWithFailover,
  stats,
  snapshotStats,
  DEAD_MODELS,
  _resetStatsForTests,
} from "./failover.mjs"
import { OpenRouterPlugin, _internal } from "./index.mjs"

const KEY_429 = `Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 requests`
const MODEL_429 = `{"error":{"code":429,"message":"Provider returned error","metadata":{"raw":"google/gemma-4-31b-it:free is temporarily rate-limited upstream"}}}`
const OTHER_429 = `{"error":{"code":429,"message":"Too many requests, please try again later"}}`

function res(body, status = 429, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "application/json", ...headers } })
}

// ---- classify429 分类识别 ----
test("classify429: free-models-per-day 是 key 级", () => {
  const info = classify429(KEY_429, {})
  assert.equal(info.kind, "key")
  assert.equal(info.limit, "free-models-per-day")
})

test("classify429: temporarily rate-limited upstream 是模型级", () => {
  const info = classify429(MODEL_429, {})
  assert.equal(info.kind, "model")
  assert.equal(info.upstream, true)
})

test("classify429: Provider returned error + 限流字样归模型级", () => {
  const info = classify429(`Provider returned error (rate limited)`, {})
  assert.equal(info.kind, "model")
})

test("classify429: 其他 Rate limit exceeded 保守归 key 级", () => {
  assert.equal(classify429(`Rate limit exceeded: shared-links-per-day`, {}).kind, "key")
})

test("classify429: 无法归类归 other", () => {
  assert.equal(classify429(OTHER_429, {}).kind, "other")
})

// ---- readRetryAfter / cooldownUntilMs ----
test("readRetryAfter: 秒数与 x-ratelimit-reset 都能读", () => {
  const now = Date.now()
  assert.equal(readRetryAfter(res("", 429, { "retry-after": "12" })), now + 12_000)
  assert.equal(readRetryAfter(res("", 429, { "x-ratelimit-reset": String(now + 3_600_000) })), now + 3_600_000)
  assert.equal(readRetryAfter(res("", 429, {})), undefined)
})

test("cooldownUntilMs: 模型级默认 60s 且至少 1s，key 级默认到次日 UTC", () => {
  const now = Date.now()
  assert.ok(cooldownUntilMs("model", undefined, now) - now >= 60_000)
  const keyUntil = cooldownUntilMs("key", undefined, now)
  assert.ok(keyUntil > now + 24 * 3600_000 - 5000)
})

// ---- parseModelFromRequest / withModel ----
test("parseModelFromRequest / withModel 改 model 字段", () => {
  const body = JSON.stringify({ model: "a/b", messages: [], provider: { sort: "throughput" } })
  assert.equal(parseModelFromRequest(body), "a/b")
  const out = JSON.parse(withModel(body, "c/d"))
  assert.equal(out.model, "c/d")
  assert.equal(out.provider.sort, "throughput", "provider 配置不被覆盖")
  assert.equal(withModel(body, "a/b"), body, "同模型不改写")
})

// ---- pickCandidate / cooldown ----
test("pickCandidate: 跳过当前与冷却中的模型", () => {
  _resetStatsForTests()
  const list = ["a", "b", "c", "d"]
  assert.equal(pickCandidate(list, "a", Date.now()), "b")
  markModelCooldown("b", Date.now() + 60_000)
  assert.equal(pickCandidate(list, "a", Date.now()), "c", "冷却中的 b 被跳过")
  clearModelCooldowns()
  assert.equal(pickCandidate(list, "a", Date.now()), "b", "冷却清理后 b 恢复")
})

test("isModelCooldown 过期后自动清除", () => {
  const now = Date.now()
  markModelCooldown("x", now + 50)
  assert.equal(isModelCooldown("x", now), true)
  assert.equal(isModelCooldown("x", now + 100), false)
  assert.equal(isModelCooldown("x", now + 100), false, "过期即删")
})

// ---- fetchWithFailover: key 级透传，不重试 ----
test("key 级 429 原样透传给 magpie，不自吞不重试", async () => {
  _resetStatsForTests()
  const calls = []
  const doFetch = async (url, init) => {
    calls.push(JSON.parse(init.body).model)
    return res(JSON.stringify({ error: { message: KEY_429 } }), 429)
  }
  const out = await fetchWithFailover(doFetch, "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ model: "openrouter/free", messages: [] }),
  }, { key: "k", candidates: ["a", "b"] })
  assert.equal(out.status, 429, "key 级原样返回 429")
  const body = JSON.parse(await out.text())
  assert.match(body.error.message, /free-models-per-day/)
  assert.equal(calls.length, 1, "key 级只发一次，不浪费请求")
  assert.equal(stats.key, 1)
})

// ---- fetchWithFailover: 模型级换模型重试 ----
test("模型级 429 切换到健康模型并成功", async () => {
  _resetStatsForTests()
  const calls = []
  const doFetch = async (url, init) => {
    const model = JSON.parse(init.body).model
    calls.push(model)
    if (model === "inclusionai/ling-3.2-flash:free") return res(MODEL_429, 429)
    return res(JSON.stringify({ id: "ok", model }), 200)
  }
  const out = await fetchWithFailover(doFetch, "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ model: "inclusionai/ling-3.2-flash:free", messages: [] }),
  }, { key: "k", candidates: ["baidu/ernie-5.5-flash-preview:free", "liquid/lfm-3-1.7b:free"] })
  assert.equal(out.status, 200)
  assert.deepEqual(calls, ["inclusionai/ling-3.2-flash:free", "baidu/ernie-5.5-flash-preview:free"])
  assert.equal(stats.model, 1)
  assert.equal(stats.switched, 1)
})

// ---- fetchWithFailover: 模型级重试上限 ----
test("模型级重试上限：模型切换只一次，全失败返回 429", async () => {
  _resetStatsForTests()
  const calls = []
  const doFetch = async (url, init) => {
    calls.push(JSON.parse(init.body).model)
    return res(MODEL_429, 429)
  }
  const out = await fetchWithFailover(doFetch, "u", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "google/gemma-4-31b-it:free", messages: [] }),
  }, { key: "k", candidates: ["a", "b", "c"] })
  assert.equal(out.status, 429)
  assert.deepEqual(calls, ["google/gemma-4-31b-it:free", "a"], "切换一次后即返回，不再无限换")
  assert.equal(stats.switched, 1)
})

// ---- fetchWithFailover: other 类短退避重试 ----
test("other 类 429 在预算内同模型退避重试，超限返回", async () => {
  _resetStatsForTests()
  const calls = []
  const doFetch = async (url, init) => {
    calls.push(1)
    return res(OTHER_429, 429)
  }
  const out = await fetchWithFailover(doFetch, "u", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  }, { key: "k", candidates: ["a"], maxRetries: 1 })
  assert.equal(out.status, 429)
  assert.equal(calls.length, 2, "1 次重试 = 共 2 次请求")
  assert.equal(stats.other, 2)
})

// ---- fetchWithFailover: fallbackToHealthy 点名死模型直接改投 ----
test("fallbackToHealthy: 点名死模型不开打上游直接改投", async () => {
  _resetStatsForTests()
  const calls = []
  const doFetch = async (url, init) => {
    calls.push(JSON.parse(init.body).model)
    return res(JSON.stringify({ ok: 1 }), 200)
  }
  const out = await fetchWithFailover(doFetch, "u", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "inclusionai/ling-3.2-flash:free", messages: [] }),
  }, { key: "k", candidates: ["baidu/ernie-5.5-flash-preview:free"], fallbackToHealthy: true })
  assert.equal(out.status, 200)
  assert.deepEqual(calls, ["baidu/ernie-5.5-flash-preview:free"], "死模型请求改投，未发出原模型")
  assert.equal(stats.switched, 1)
})

// ---- 插件集成：healthyModelsOnly 隐藏死模型 ----
test("插件 healthyModelsOnly 在 models 钩子隐藏 3 个死模型", async () => {
  const hooks = await OpenRouterPlugin({}, { healthyModelsOnly: true })
  const provider = { models: { "inclusionai/ling-3.2-flash:free": { name: "ling" }, "google/gemma-4-31b-it:free": { name: "g31" }, "google/gemma-4-26b-a4b-it:free": { name: "g26" }, "baidu/ernie-5.5-flash-preview:free": { name: "ernie", free: true } } }
  const out = await hooks.provider.models(provider, {})
  assert.ok(!("inclusionai/ling-3.2-flash:free" in out))
  assert.ok(!("google/gemma-4-31b-it:free" in out))
  assert.ok(!("google/gemma-4-26b-a4b-it:free" in out))
  assert.ok("baidu/ernie-5.5-flash-preview:free" in out)
})

// ---- 插件集成：loader.fetch 走 failover，健康模型直连成功 ----
test("loader.fetch 集成：健康模型请求透传成功", async () => {
  const hooks = await OpenRouterPlugin({})
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "sk-or-v1-test" }))
  const seen = []
  const out = await (async () => {
    const prev = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body).model })
      return res(JSON.stringify({ id: "done" }), 200)
    }
    try {
      return await loaded.fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-or-v1-test", "content-type": "application/json" },
        body: JSON.stringify({ model: "nvidia/nemotron-3.5-lightning:free", messages: [] }),
      })
    } finally {
      globalThis.fetch = prev
    }
  })()
  assert.equal(out.status, 200)
  assert.equal(seen[0].body, "nvidia/nemotron-3.5-lightning:free")
})

// ---- 插件集成：点名死模型 + fallbackToHealthy，经 loader.fetch 改投 ----
test("loader.fetch 集成：fallbackToHealthy 把死模型改投健康模型", async () => {
  const hooks = await OpenRouterPlugin({}, { fallbackToHealthy: true })
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "sk-or-v1-test" }))
  const seen = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body).model)
    return res(JSON.stringify({ id: "done" }), 200)
  }
  try {
    const out = await loaded.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-or-v1-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "google/gemma-4-26b-a4b-it:free", messages: [] }),
    })
    assert.equal(out.status, 200)
    assert.equal(seen.length, 1, "改投后只发一次健康模型")
    assert.ok(!seen.includes("google/gemma-4-26b-a4b-it:free"))
  } finally {
    globalThis.fetch = prev
  }
})

// ---- 统计与快照 ----
test("snapshotStats 返回分类计数", () => {
  _resetStatsForTests()
  stats.key = 2
  stats.model = 1
  const snap = snapshotStats()
  assert.equal(snap.key, 2)
  assert.equal(snap.model, 1)
  assert.ok(Array.isArray(snap.history))
})

test("DEAD_MODELS 覆盖 ling-3.2 与 gemma-4-*", () => {
  assert.ok(DEAD_MODELS.has("inclusionai/ling-3.2-flash:free"))
  assert.ok(DEAD_MODELS.has("google/gemma-4-31b-it:free"))
  assert.ok(DEAD_MODELS.has("google/gemma-4-26b-a4b-it:free"))
})

// ---- _internal 暴露 failover 工具 ----
test("_internal 暴露 failover 统计与工具", () => {
  assert.equal(typeof _internal.failover.snapshotStats, "function")
  assert.equal(typeof _internal.failover.classify429, "function")
  assert.ok(_internal.failover.DEAD_MODELS instanceof Set)
})
