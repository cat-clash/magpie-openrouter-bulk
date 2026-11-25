import assert from "node:assert/strict"
import test from "node:test"
import { prepare, rewriteURL, withProviderSort } from "./request.mjs"

test("systemone is sent to the Decisions API", () => {
  assert.equal(
    rewriteURL("https://openrouter.ai/api/v1/systemone"),
    "https://openrouter.ai/api/alpha/decisions",
  )
  assert.equal(
    rewriteURL("https://openrouter.ai/api/v1/chat/completions"),
    "https://openrouter.ai/api/v1/chat/completions",
  )
})

test("provider sort is added only when the request did not set one", () => {
  const body = JSON.stringify({ model: "a/b", messages: [] })
  const sorted = JSON.parse(withProviderSort(body, "throughput"))
  assert.equal(sorted.provider.sort, "throughput")
  assert.equal(sorted.model, "a/b")

  const own = JSON.stringify({ model: "a/b", provider: { sort: "latency", order: ["anthropic"] } })
  assert.equal(withProviderSort(own, "price"), own)
  assert.equal(withProviderSort(body, "cheapest"), body)
  assert.equal(withProviderSort("{", "price"), "{")
})

test("prepare rewrites classifiers and drops a stale content-length", () => {
  const sent = prepare("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "2", authorization: "Bearer sk-or-v1-x" },
    body: JSON.stringify({ model: "a/b" }),
  }, { sort: "price" })
  assert.equal(sent.url.endsWith("/chat/completions"), true)
  assert.equal(JSON.parse(sent.init.body).provider.sort, "price")
  assert.equal(sent.init.headers.get("content-length"), null)
  assert.equal(sent.init.headers.get("authorization"), "Bearer sk-or-v1-x")

  const decision = prepare("https://openrouter.ai/api/v1/systemone", {
    method: "POST",
    body: JSON.stringify({ model: "perplexity/pplx-decider-v1.2", state: "hi", questions: {} }),
  })
  assert.equal(decision.url, "https://openrouter.ai/api/alpha/decisions")
  assert.equal(JSON.parse(decision.init.body).model, "perplexity/pplx-decider-v1.2")
})
