// src/pacing.test.mjs — 节奏闸用例（纯内存 + 注入时钟，不碰网络）
//
// 覆盖：默认零延迟、间隔闸、滑动窗口不超速、日额度短路、重置后恢复、refund、
// 快照、并发占位安全、noteUsage 解析。

import assert from "node:assert/strict"
import test from "node:test"

import { createPacer } from "./pacing.mjs"

const T0 = 1_700_000_000_000

// 虚拟时钟：sleep 在**下一个微任务**才推进 now，模拟真实 setTimeout 的异步语义 ——
// 这样同一批同步发起的 take() 会先各自占位，再一起"等待"，并发行为跟线上一致。
function harness(opts = {}) {
  let t = T0
  const sleeps = []
  const pacer = createPacer({
    ...opts,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms)
      await Promise.resolve()
      t += ms
    },
  })
  return { pacer, sleeps, clock: () => t }
}

test("默认配置不引入延迟（requestIntervalMs=0）", async () => {
  const { pacer, sleeps } = harness()
  const first = await pacer.take("sk-or-a")
  const second = await pacer.take("sk-or-a")
  assert.equal(first.allowed, true)
  assert.equal(second.allowed, true)
  assert.equal(first.waitMs, 0)
  assert.equal(second.waitMs, 0)
  assert.deepEqual(sleeps, [], "默认配置一次都不睡")
  const snap = pacer.snapshot()
  assert.equal(snap.requestIntervalMs, 0)
  assert.equal(snap.freeRpmLimit, 20)
  assert.equal(snap.dailyGuard, true)
})

test("间隔闸：同一 key 相邻两次放行至少间隔 requestIntervalMs，不同 key 互不影响", async () => {
  const { pacer } = harness({ requestIntervalMs: 800, freeRpmLimit: 0 })
  assert.equal((await pacer.take("k1")).waitMs, 0)
  const second = await pacer.take("k1")
  assert.equal(second.waitMs, 800, "第二次等满 800ms")
  const other = await pacer.take("k2")
  assert.equal(other.waitMs, 0, "不同 key 有自己的时间轴")
})

test("滑动窗口：超出每分钟配额时排队到最早一笔滑出窗口", async () => {
  const { pacer, sleeps } = harness({ freeRpmLimit: 3, windowMs: 60_000 })
  const waits = []
  for (let i = 0; i < 3; i++) waits.push((await pacer.take("k1")).waitMs)
  assert.deepEqual(waits, [0, 0, 0], "前三笔不排队")
  assert.equal(pacer.snapshot().remaining, 0, "窗口正好用满")
  const fourth = await pacer.take("k1")
  assert.equal(fourth.waitMs, 60_000, "第四笔要等最早一笔滑出窗口")
  assert.deepEqual(sleeps, [60_000])
  // 睡到 T0+60s 后，前三笔已滑出窗口，窗口里只剩第四笔自己。
  const snap = pacer.snapshot()
  assert.equal(snap.freeRpmLimit, 3)
  assert.equal(snap.used, 1)
  assert.equal(snap.remaining, 2)
})

test("日额度剩余 0 时直接短路，一个字节都不发", async () => {
  const { pacer, sleeps } = harness()
  pacer.noteDaily("k1", 0, T0 + 3_600_000)
  const ticket = await pacer.take("k1")
  assert.equal(ticket.allowed, false)
  assert.equal(ticket.reason, "daily-exhausted")
  assert.equal(ticket.remaining, 0)
  assert.deepEqual(sleeps, [], "短路时也不睡")
  assert.equal(pacer.snapshot().counters.blocked, 1)
})

test("重置时刻已过则恢复放行；dailyGuard=false 时完全不拦", async () => {
  const a = harness()
  a.pacer.noteDaily("k1", 0, T0 - 1000) // 重置时刻在过去
  assert.equal((await a.pacer.take("k1")).allowed, true)

  const b = harness({ dailyGuard: false })
  b.pacer.noteDaily("k1", 0, T0 + 3_600_000)
  assert.equal((await b.pacer.take("k1")).allowed, true)
})

test("refund 把最近一次占位还给窗口", async () => {
  const { pacer } = harness({ freeRpmLimit: 1, windowMs: 60_000 })
  assert.equal((await pacer.take("k1")).waitMs, 0)
  assert.equal(pacer.refund("k1"), true, "退格成功")
  assert.equal((await pacer.take("k1")).waitMs, 0, "退还后不必等窗口滑出")
  assert.equal(pacer.refund("unknown"), false, "没有占位可退时返回 false")
  assert.equal(pacer.snapshot().counters.refunded, 1)
})

test("snapshot 暴露窗口用量、剩余、日额度与计数器", async () => {
  const { pacer } = harness({ freeRpmLimit: 5 })
  await pacer.take("k1")
  await pacer.take("k2")
  pacer.noteUsage("k1", {
    windows: [
      { name: "free models", amount: 47, limit: 50, resetsAt: new Date(T0 + 86_400_000).toISOString() },
    ],
  })
  const snap = pacer.snapshot()
  assert.equal(snap.used, 2)
  assert.equal(snap.remaining, 3)
  assert.equal(snap.rpmScope, "key")
  assert.deepEqual(Object.keys(snap.perBucket).sort(), ["k1", "k2"])
  assert.equal(snap.axes, 2)
  assert.equal(snap.daily.k1.remaining, 3)
  assert.equal(typeof snap.daily.k1.resetsAt, "string")
  assert.equal(snap.counters.taken, 2)
})

test("noteUsage 识别 free models 窗口：剩 3 次照常放行，剩 0 次立刻短路", async () => {
  const { pacer } = harness()
  const report = (amount) => ({
    windows: [{ name: "free models", amount, limit: 50, resetsAt: new Date(T0 + 86_400_000).toISOString() }],
  })
  assert.equal(pacer.noteUsage("k1", report(47)), true)
  assert.equal((await pacer.take("k1")).allowed, true)
  pacer.noteUsage("k1", report(50))
  const denied = await pacer.take("k1")
  assert.equal(denied.allowed, false)
  assert.equal(denied.reason, "daily-exhausted")
  assert.equal(pacer.noteUsage("k1", { windows: [] }), false, "没有 free models 窗口时不污染状态")
})

test("并发安全：同步占位，窗口内放行数不超配额且槽位互不重叠", async () => {
  const { pacer } = harness({ freeRpmLimit: 3, windowMs: 60_000 })
  const tickets = await Promise.all(Array.from({ length: 9 }, () => pacer.take("k1")))
  assert.ok(tickets.every((tk) => tk.allowed))
  const waits = tickets.map((tk) => tk.waitMs)
  assert.equal(waits.filter((w) => w === 0).length, 3, "只有配额内的 3 笔能立即放行")
  // 9 笔 / 每窗口 3 笔 → 分三批：0s、60s、120s。占位同步完成，所以批次不会重叠。
  assert.deepEqual(
    waits.slice().sort((a, b) => a - b),
    [0, 0, 0, 60_000, 60_000, 60_000, 120_000, 120_000, 120_000],
  )
})

test("rpmScope=global 时所有账号共用一个窗口", async () => {
  const { pacer } = harness({ freeRpmLimit: 2, rpmScope: "global" })
  assert.equal((await pacer.take("k1")).waitMs, 0)
  assert.equal((await pacer.take("k2")).waitMs, 0)
  assert.equal((await pacer.take("k3")).waitMs, 60_000, "第三个 key 撞全局窗口")
  assert.deepEqual(Object.keys(pacer.snapshot().perBucket), ["*"])
})

test("loader 接线：/key 快照显示日额度用尽后，请求直接短路成合成 429，不打上游", async () => {
  const { OpenRouterPlugin } = await import("../index.mjs")
  const hooks = await OpenRouterPlugin({}, { dailyGuard: true })
  const getAuth = async () => ({ type: "api", key: "sk-or-v1-guard" })
  const upstream = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith("/key")) {
      return new Response(
        JSON.stringify({ data: { name: "work", free_model_daily_requests: { limit: 50, used: 50 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    upstream.push({ url: u, init })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    // auth.usage 读 /key → 把 free models 剩余额度喂给节奏闸
    const report = await hooks.auth.usage(getAuth)
    assert.ok(report.windows.some((w) => w.name === "free models"), "usage 报告里带 free models 窗口")

    const loaded = await hooks.auth.loader(getAuth)
    const res = await loaded.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-or-v1-guard", "content-type": "application/json" },
      body: JSON.stringify({ model: "nvidia/nemotron-3.5-lightning:free", messages: [] }),
    })
    assert.equal(res.status, 429, "短路成 429")
    const text = await res.text()
    assert.match(text, /free-models-per-day/, "body 是 key 级 429 特征，magpie 会换账号")
    assert.equal(upstream.length, 0, "一个上游请求都没发")
    assert.equal(res.headers.get("x-ratelimit-reset") !== null, true, "透出重置时刻")
  } finally {
    globalThis.fetch = previous
  }
})
