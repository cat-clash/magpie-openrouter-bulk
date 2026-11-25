import assert from "node:assert/strict"
import test from "node:test"
import { OpenRouterPlugin, _internal } from "./index.mjs"

const PROVIDER = _internal.PROVIDER

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

async function withFetch(impl, fn) {
  const previous = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = previous
  }
}

test("the entry exports only the plugin function and _internal", async () => {
  const mod = await import("./index.mjs")
  assert.deepEqual(Object.keys(mod).sort(), ["OpenRouterPlugin", "_internal"])
  assert.equal(typeof mod.OpenRouterPlugin, "function")
  assert.equal(typeof mod._internal, "object")
})

test("config declares the provider without touching one the user already set", async () => {
  const hooks = await OpenRouterPlugin({})
  const cfg = { provider: { [PROVIDER]: { name: "Mine", models: { keep: { name: "Keep" } } } } }
  await hooks.config(cfg)
  assert.equal(cfg.provider[PROVIDER].name, "Mine")
  const fresh = {}
  await hooks.config(fresh)
  assert.equal(fresh.provider[PROVIDER].name, "OpenRouter")
  assert.equal(fresh.provider[PROVIDER].decide, true)
  assert.equal(fresh.provider[PROVIDER].npm, "@ai-sdk/openai-compatible")
  assert.ok(fresh.provider[PROVIDER].models["openrouter/auto"])
})

test("loader signs chat requests and usage names the account from the key", async () => {
  const saved = []
  const hooks = await OpenRouterPlugin(
    { client: { auth: { async set(body) { saved.push(body) } } } },
    { referer: "https://example.com", title: "Example", sort: "throughput" },
  )
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "sk-or-v1-secret" }))
  assert.equal(loaded.apiKey, "sk-or-v1-secret")
  assert.equal(loaded.headers["HTTP-Referer"], "https://example.com")
  assert.equal(loaded.headers["X-OpenRouter-Title"], "Example")

  await withFetch(async (url, init) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions")
    assert.equal(JSON.parse(init.body).provider.sort, "throughput")
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer sk-or-v1-secret")
    return json({ ok: true })
  }, () =>
    loaded.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-or-v1-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [] }),
    }),
  )

  const report = await withFetch(async (url) => {
    if (String(url).endsWith("/credits")) return json({}, 403)
    return json({ data: { name: "work", is_free_tier: false, limit: null, usage_daily: 0 } })
  }, () => hooks.auth.usage(async () => ({ type: "api", key: "sk-or-v1-secret" })))
  assert.equal(report.user, "work")
  assert.equal(saved.length, 1)
  assert.equal(saved[0].body.metadata.email, "work")
  assert.equal(saved[0].body.key, "sk-or-v1-secret")
  assert.equal(saved[0].path.id, PROVIDER)
})

test("models keeps the previous list when the catalog cannot be read", async () => {
  const hooks = await OpenRouterPlugin({})
  const provider = { models: { "openrouter/auto": { name: "OpenRouter Auto" } } }
  const same = await hooks.provider.models(provider, {})
  assert.equal(same, provider.models)

  const kept = await withFetch(async () => json({}, 500), () =>
    hooks.provider.models(provider, { auth: { type: "api", key: "sk-or-v1-x" } }),
  )
  assert.equal(kept, provider.models)

  await assert.rejects(
    () =>
      withFetch(
        async () => json({}, 401),
        () => hooks.provider.models(provider, { auth: { type: "api", key: "sk-or-v1-x" } }),
      ),
    (err) => err.signIn === "expired",
  )
})

test("models replaces the static list with the live catalog", async () => {
  const hooks = await OpenRouterPlugin({}, { output: "text" })
  const provider = { models: { "openrouter/auto": { name: "static" } } }
  const listed = await withFetch(async (url) => {
    if (String(url).endsWith("/key")) return json({ data: { name: "work" } })
    return json({
      data: [
        {
          id: "deepseek/deepseek-v4-flash",
          name: "Flash",
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          pricing: { prompt: "0.00000015", completion: "0.0000006" },
          supported_parameters: ["tools"],
          top_provider: { context_length: 128000, max_completion_tokens: 8192 },
        },
        {
          id: "perplexity/pplx-decider-v1.2",
          name: "Decider",
          architecture: { output_modalities: ["decisions"] },
          pricing: { prompt: "0.00000002", completion: "0" },
        },
      ],
      links: { next: null },
    })
  }, () => hooks.provider.models(provider, { auth: { type: "api", key: "sk-or-v1-x" } }))
  assert.deepEqual(Object.keys(listed), ["deepseek/deepseek-v4-flash"])
  assert.equal(listed["deepseek/deepseek-v4-flash"].cost.input, 0.15)
})

test("catalog is shared across accounts within the TTL", async () => {
  _internal.clearCatalogCache()
  const hooks = await OpenRouterPlugin({}, { output: "text" })
  const provider = { models: { "openrouter/auto": { name: "static" } } }
  const calls = []
  await withFetch(async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.endsWith("/key")) return json({ data: { name: "work" } })
    return json({
      data: [{ id: "a/b", name: "B", architecture: { output_modalities: ["text"] } }],
      links: { next: null },
    })
  }, async () => {
    await hooks.provider.models(provider, { auth: { type: "api", key: "sk-or-v1-one" } })
    await hooks.provider.models(provider, { auth: { type: "api", key: "sk-or-v1-two" } })
  })
  assert.equal(calls.filter((u) => u.includes("/models")).length, 1, "models fetched once for two accounts")
  assert.equal(calls.filter((u) => u.endsWith("/key")).length, 2, "each account key still probed")
  _internal.clearCatalogCache()
})
