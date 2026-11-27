// src/risk.test.mjs — 风控熔断层用例（纯内存 + 注入时钟/随机 + 临时落盘目录）
//
// 覆盖：账号桶/标签、熔断状态机（阈值→open→半开→关闭/重开、指数退避、jitter）、
// 持久化（落盘重启不丢）、shouldGate fail-fast、跨账号共因闸、loader 接线、
// 模型冷却落盘与启动灌回。

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { createBreaker, getBreaker, shouldGate, resetAllBreakers, breakerBuckets, accountKeyOf, accountLabelOf, addPersistedModelCooldown, loadPersistedModelCooldowns, hydrateModelCooldowns, persistedModelCooldownSnapshot, _riskInternals, _resetRiskForTests } = await import("./risk.mjs")

let riskDir
test.beforeEach(() => {
  riskDir = mkdtempSync(join(tmpdir(), "or-risk-test-"))
  process.env.OPENROUTER_RISK_DIR = riskDir
  _resetRiskForTests()
})
test.afterEach(() => {
  try { rmSync(riskDir, { recursive: true, force: true }) } catch { /* ignore */ }
  for (const k of ["OPENROUTER_RISK_DIR", "OPENROUTER_RISK_THRESHOLD", "OPENROUTER_RISK_COOLDOWN_MS", "OPENROUTER_RISK_SCOPE", "OPENROUTER_RISK_CONSENSUS", "OPENROUTER_RISK_WINDOW_MS"]) delete process.env[k]
})

test("accountKeyOf / accountLabelOf", () => {
  const k = "sk-or-v1-abcdef123456"
  const bucket = accountKeyOf(k)
  assert.equal(bucket.length, 12, "稳定短哈希 12 位")
  assert.equal(accountKeyOf(k), bucket, "同 key 同桶")
  assert.notEqual(accountKeyOf(k), accountKeyOf("sk-or-v1-xyz789"), "不同 key 不同桶")
  assert.equal(accountKeyOf(""), "*", "无 key 退化到全局桶")
  assert.match(accountLabelOf(k), /sk-or-…/, "脱敏标签")
})

test("熔断：连续失败达阈值即 open，冷却到期半开放行探测，成功后半开关闭", async () => {
  let t = 1_000_000_000_000
  const br = createBreaker({ threshold: 2, cooldownMs: 1000, now: () => t, random: () => 0, bucket: "b1" })
  assert.equal(br.open, false)
  br.record(false)
  assert.equal(br.open, false, "未达阈值不熔断")
  br.record(false)
  assert.equal(br.open, true, "连续 2 次失败后熔断")
  assert.equal(br.retryAfterMs > 0, true)

  t += 1001 // 冷却到期 → 半开
  assert.equal(br.open, false, "半开放行探测请求")
  br.record(true) // 探测成功 → 关闭清零
  assert.equal(br.open, false)
  assert.equal(br.failures, 0)
})

test("shouldGate：账号自身熔断时 fail-fast，未熔断放行", async () => {
  process.env.OPENROUTER_RISK_THRESHOLD = "2"
  process.env.OPENROUTER_RISK_COOLDOWN_MS = "1000"
  const b1 = getBreaker("gate-b", "lab")
  b1.record(false)
  b1.record(false)
  const g = shouldGate("gate-b")
  assert.equal(g.gate, true)
  assert.equal(g.reason, "account")
  assert.equal(g.retryAfterMs > 0, true)
  assert.equal(shouldGate("healthy-bucket").gate, false, "未熔断的桶放行")
})

test("熔断：半开探测失败立即重开，退避翻倍", async () => {
  let t = 1_000_000_000_000
  const br = createBreaker({ threshold: 1, cooldownMs: 1000, now: () => t, random: () => 0, bucket: "b2" })
  br.record(false)
  assert.equal(br.open, true)
  const c0 = br.retryAfterMs
  t += 1001
  br.record(false) // 半开失败 → 重开，退避 ×2
  assert.equal(br.open, true)
  assert.ok(br.retryAfterMs >= c0, "重开后冷却不短于前一轮（退避翻倍）")
  assert.equal(br.consecutiveOpens, 1)
})

test("jitter：熔断冷却叠加 ±10% 随机，且本轮内稳定", async () => {
  let t = 1_000_000_000_000
  const br = createBreaker({ threshold: 1, cooldownMs: 1000, now: () => t, random: () => 1, bucket: "b3" })
  br.record(false)
  const capped = 1000 * 2 ** 0
  const expectJitter = (1 * 2 - 1) * capped * 0.1 // 0.1
  assert.ok(Math.abs(br.retryAfterMs - (capped + expectJitter)) < 1, "jitter 叠加在封顶值上")
  assert.equal(br.retryAfterMs, br.retryAfterMs, "本轮内 retryAfterMs 稳定")
})

test("持久化：落盘重启不丢冷却", async () => {
  const now = Date.now() // 用真实时钟，避免时钟偏移守卫误判
  const br = createBreaker({ threshold: 1, cooldownMs: 60000, now: () => now, random: () => 0, bucket: "persist" })
  br.record(false)
  assert.equal(br.open, true)

  _resetRiskForTests() // 模拟进程重启（只清内存，落盘文件保留）
  const revived = getBreaker("persist", "", { now: () => Date.now() })
  assert.equal(revived.open, true, "重启后仍冷却（从落盘恢复）")
  assert.equal(revived.retryAfterMs > 0, true)
})

test("shouldGate：闭 → 放行；open → gate；cooldown=0 永不熔断", () => {
  let t = 1_000_000_000_000
  const br = createBreaker({ threshold: 1, cooldownMs: 0, now: () => t, bucket: "off" })
  for (let i = 0; i < 10; i++) br.record(false)
  assert.equal(br.open, false, "cooldown=0 时禁用熔断")
  assert.equal(shouldGate("off").gate, false)
  assert.equal(shouldGate("unknown").gate, false, "未熔断的桶放行")
})

test("reset：人为解除冷却", async () => {
  let t = 1_000_000_000_000
  const br = createBreaker({ threshold: 1, cooldownMs: 60000, now: () => t, random: () => 0, bucket: "r" })
  br.record(false)
  assert.equal(br.open, true)
  br.reset()
  assert.equal(br.open, false)
  assert.equal(br.failures, 0)
})

test("跨账号共因闸：窗口内不同账号先后熔断 → 全局桶打开、全池 fail-fast", async () => {
  process.env.OPENROUTER_RISK_CONSENSUS = "2"
  process.env.OPENROUTER_RISK_WINDOW_MS = "600000"
  process.env.OPENROUTER_RISK_COOLDOWN_MS = "60000"
  const now = () => Date.now()
  // 走真实池：getBreaker 的 onOpen 统一接 noteBucketTrip（与生产语义一致）
  const a = getBreaker("acctA", "", { threshold: 1, cooldownMs: 60000, now, random: () => 0 })
  const b = getBreaker("acctB", "", { threshold: 1, cooldownMs: 60000, now, random: () => 0 })
  a.record(false)
  b.record(false) // 两个不同账号先后熔断（各触发 onOpen → noteBucketTrip）
  const g = getBreaker("*") // 当前全局桶（共因闸打开的）
  assert.equal(g.open, true, "共因闸打开全局桶")
  assert.equal(shouldGate("acctC").gate, true, "其他账号也被全局冷却拦住")
  assert.equal(shouldGate("acctC").reason, "cross-account")
})

test("loader 接线：账号熔断时合成 429（risk-gated），不打上游", async () => {
  const { OpenRouterPlugin } = await import("../index.mjs")
  process.env.OPENROUTER_RISK_COOLDOWN_MS = "60000"
  const key = "sk-or-v1-breaker"
  const bucket = accountKeyOf(key)
  getBreaker(bucket, accountLabelOf(key)).trip("test") // 手动把该账号熔断

  const hooks = await OpenRouterPlugin({}, {})
  const getAuth = async () => ({ type: "api", key })
  const upstream = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    upstream.push(String(url))
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    const loaded = await hooks.auth.loader(getAuth)
    const res = await loaded.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "nvidia/nemotron-3.5-lightning:free", messages: [] }),
    })
    assert.equal(res.status, 429)
    const text = await res.text()
    assert.match(text, /risk-gated/, "熔断合成 429 的标记")
    assert.doesNotMatch(text, /free-models-per-day/, "刻意避开 key 级日额度标记（防 +35 天 rest bug）")
    assert.ok(Number(res.headers.get("retry-after")) > 0, "带 retry-after 让 magpie 短暂 rest 后换账号")
    assert.equal(upstream.length, 0, "一个上游请求都没发")
  } finally {
    globalThis.fetch = previous
  }
})

test("模型冷却落盘 + 启动灌回", async () => {
  const future = Date.now() + 120_000
  addPersistedModelCooldown("dead/model:free", future)
  const loaded = loadPersistedModelCooldowns()
  assert.equal(loaded.some(([m]) => m === "dead/model:free"), true)
  const marked = []
  hydrateModelCooldowns((m, u) => marked.push([m, u]))
  assert.equal(marked.some(([m, u]) => m === "dead/model:free" && u === future), true, "灌回 failover 内存表")
  assert.ok(persistedModelCooldownSnapshot()["dead/model:free"], "快照可见")
})

test("resetAllBreakers 解除所有桶冷却", async () => {
  let t = 1_000_000_000_000
  getBreaker("x", "").trip("t")
  assert.equal(getBreaker("x").open, true)
  const n = resetAllBreakers()
  assert.ok(n >= 1)
  assert.equal(getBreaker("x").open, false)
})
