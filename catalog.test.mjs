import assert from "node:assert/strict"
import test from "node:test"
import { fetchCatalog, keep, nextLink, perMillion, toModel } from "./catalog.mjs"

const text = {
  id: "deepseek/deepseek-v4-flash",
  name: "DeepSeek: V4 Flash",
  created: 1792225624,
  context_length: 1048576,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" },
  top_provider: { context_length: 1048576, max_completion_tokens: 393216 },
  supported_parameters: ["tools", "reasoning_effort", "temperature"],
  reasoning: { default_enabled: true, supported_efforts: ["max", "high", "low", "none"] },
}

const free = {
  id: "nvidia/nemotron:free",
  name: "Nemotron (free)",
  created: 1700000000,
  context_length: 8192,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0", completion: "0" },
  top_provider: { context_length: 8192, max_completion_tokens: 4096 },
  supported_parameters: ["tools"],
}

const decision = {
  id: "perplexity/pplx-decider-v1.2",
  name: "Perplexity: Decider V1.2",
  created: 1792183495,
  context_length: 262144,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] },
  pricing: { prompt: "0.00000002", completion: "0" },
  top_provider: { context_length: 262144, max_completion_tokens: 235929 },
  supported_parameters: [],
}

const image = {
  id: "black-forest-labs/flux",
  name: "Flux",
  architecture: { input_modalities: ["text"], output_modalities: ["image"] },
  pricing: { prompt: "0", completion: "0" },
}

const alias = {
  id: "~deepseek/deepseek-latest",
  name: "DeepSeek latest",
  architecture: { output_modalities: ["text"] },
  pricing: { prompt: "-1", completion: "-1" },
}

const router = {
  id: "openrouter/auto",
  name: "Auto",
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "-1", completion: "-1" },
  supported_parameters: ["tools"],
}

test("perMillion converts OpenRouter per-token prices", () => {
  assert.equal(perMillion("0.00000015"), 0.15)
  assert.equal(perMillion("0.0000006"), 0.6)
  assert.equal(perMillion("-1"), undefined)
  assert.equal(perMillion(""), undefined)
})

test("toModel fills cost, tools, efforts and context", () => {
  const model = toModel(text, Date.parse("2026-10-18T00:00:00Z"))
  assert.equal(model.id, text.id)
  assert.equal(model.limit.context, 1048576)
  assert.equal(model.limit.output, 393216)
  assert.equal(model.tool_call, true)
  assert.equal(model.reasoning, true)
  assert.deepEqual(Object.keys(model.variants), ["max", "high", "low", "none"])
  assert.deepEqual(model.modalities.input, ["text", "image"])
  assert.equal(model.cost.input, 0.15)
  assert.equal(model.cost.output, 0.6)
  assert.equal(model.cost.cache_read, 0.003)
  assert.equal(model.cost.cache.read, 0.003)
  assert.equal(model.release_date, "2026-10-17")
  assert.equal(model.free, undefined)
  assert.equal(model.decides, undefined)
})

test("free and decision models are marked, dynamic prices are omitted", () => {
  assert.equal(toModel(free).free, true)
  const decided = toModel(decision)
  assert.equal(decided.decides, true)
  assert.equal(decided.free, undefined)
  assert.equal(decided.tool_call, false)
  assert.equal(decided.cost.input, 0.02)
  assert.equal(decided.cost.output, 0)
  assert.equal(toModel(router).cost, undefined)
})

test("an expiration in the past hides the model", () => {
  const model = toModel(
    { ...text, expiration_date: "2020-01-01T00:00:00Z" },
    Date.parse("2026-10-18T00:00:00Z"),
  )
  assert.equal(model.status, "deprecated")
})

test("keep drops aliases and non-text models unless asked", () => {
  assert.equal(keep(text), true)
  assert.equal(keep(decision), true)
  assert.equal(keep(image), false)
  assert.equal(keep(alias), false)
  assert.equal(keep(image, { output: "all" }), true)
  assert.equal(keep(alias, { includeAliases: true }), true)
  assert.equal(keep(decision, { output: "text" }), false)
})

test("nextLink stays on OpenRouter's model list", () => {
  assert.equal(
    nextLink("/api/v1/models?offset=200&limit=200"),
    "https://openrouter.ai/api/v1/models?offset=200&limit=200",
  )
  assert.equal(nextLink("https://evil.example/api/v1/models"), "")
  assert.equal(nextLink("https://openrouter.ai/api/v1/key"), "")
  assert.equal(nextLink(null), "")
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

test("fetchCatalog pages, filters, and refuses a rejected key", async () => {
  const calls = []
  const doFetch = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith("/key")) return json({ data: { name: "work" } })
    if (String(url).includes("offset=200")) {
      return json({ data: [free], links: { next: null } })
    }
    return json({
      data: [text, decision, image, alias, router],
      links: { next: "/api/v1/models?output_modalities=all&offset=200&limit=200" },
    })
  }
  const models = await fetchCatalog(doFetch, { key: "sk-or-v1-test" })
  assert.deepEqual(Object.keys(models), [text.id, decision.id, router.id, free.id])
  assert.equal(models[decision.id].decides, true)
  assert.equal(models[free.id].free, true)
  assert.equal(calls.length, 3)

  await assert.rejects(
    () => fetchCatalog(async (url) => (String(url).endsWith("/key") ? json({}, 401) : json({})), { key: "nope" }),
    (err) => err.signIn === "expired",
  )
})
