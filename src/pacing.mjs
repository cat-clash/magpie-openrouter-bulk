// src/pacing.mjs — 请求节奏控制（间隔闸 + 抖动 + 免费额度窗口 + 日额度短路）
//
// 四件事，各自独立、可单独关掉：
//
//   ① 最小请求间隔    requestIntervalMs（默认 250）
//      同一把 key 相邻两次放行的最小间隔。默认 250ms —— 不要 0：58 账号池从同一出口 IP
//      无节流连发是「总是限流」的诱因（移植自 marvis 0.8 的教训：节奏闸是预防，熔断是止损）。
//      显式传 0 = 关闭间隔闸。
//
//   ② 随机抖动         requestJitterMs（默认 120）
//      每次放行叠加 random()*jitterMs 的抖动，把固定间隔打散成接近人的随机分布，也把
//      进程启动后第一批请求错开。显式传 0 = 关闭抖动。只叠加在睡眠上，不污染窗口槽位。
//
//   ③ 免费模型分钟配额 freeRpmLimit（默认 20）/ windowMs（默认 60000）
//      OpenRouter 免费模型是「20 请求/分钟」的平台硬限（每个 key 各自一份）。这里用
//      **滑动窗口**而不是固定窗口：固定窗口在窗口边界会放过 2×限制。默认 rpmScope="key"
//      —— 与平台语义一致（每 key 一份）；改成 "global" 则所有账号共用一个窗口（58 账号池
//      下会把总吞吐压到 20/min，除非你确实想给出口 IP 限速）。
//
//   ④ 日额度短路      dailyGuard（默认 true）
//      从最近一次 GET /key 快照读 free_model_daily_requests 的 remaining，剩 0 且
//      重置时刻未到 → take() 直接返回 allowed:false，**一个字节都不发**。loader 会把
//      它翻译成合成的 key 级 429，magpie 随即换账号 —— 比白发一次必 429 的请求便宜。
//      快照来源：auth.usage 每次读 /key 后 noteUsage() 喂进来。
//
// 并发安全：take() 的**占位是同步完成的**（JS 单线程原子），再 await 睡眠。所以并发调用方
// 按调用顺序落在同一条时间轴上，实际启动间隔 ≥ 间隔闸、窗口内放行数 ≤ 配额；不是互斥队列，
// 每个调用方各睡自己的槽位。
//
// 纯内存、零 IO、零依赖；now / sleep / random 可注入，测试可完全确定化。

const DEFAULT_WINDOW_MS = 60 * 1000
const DEFAULT_INTERVAL_MS = 250
const DEFAULT_JITTER_MS = 120

function nonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * createPacer(opts) → { take(key), refund(key), noteUsage(key, report), snapshot() }
 *
 * take(key)  → { allowed: true,  waitMs, key }              已占位（并睡到槽位）
 *            → { allowed: false, reason, remaining, resetsAt } 日额度用尽，未占位、未睡眠
 * refund(key) → boolean，把该 key 最近一次占位还给窗口（429 后调用）
 * noteUsage(key, report)  → 从 magpie 的 usage 报告里取「free models」窗口剩余额度
 * snapshot() → 诊断快照（窗口用量、剩余、每条时间轴、日额度表）
 */
export function createPacer(opts = {}) {
  const requestIntervalMs = nonNegative(opts.requestIntervalMs, DEFAULT_INTERVAL_MS)
  const requestJitterMs = nonNegative(opts.requestJitterMs, DEFAULT_JITTER_MS)
  const freeRpmLimit = nonNegative(opts.freeRpmLimit, 20)
  const rpmScope = opts.rpmScope === "global" ? "global" : "key"
  const dailyGuard = opts.dailyGuard !== false
  const windowMs = nonNegative(opts.windowMs, DEFAULT_WINDOW_MS)
  const now = typeof opts.now === "function" ? opts.now : Date.now
  const doSleep = typeof opts.sleep === "function" ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms))
  const doRandom = typeof opts.random === "function" ? opts.random : Math.random

  const GLOBAL = "*"
  const axes = new Map() // key -> 上次占位的时刻（计划值，含等待）
  const windows = new Map() // bucket -> 窗口内已占位的时刻（升序）
  const daily = new Map() // key -> { remaining, resetsAt(ms|null) }
  const counters = { taken: 0, waited: 0, refunded: 0, blocked: 0 }

  const bucketOf = (key) => (rpmScope === "global" ? GLOBAL : String(key ?? "") || GLOBAL)

  function windowOf(bucket) {
    let list = windows.get(bucket)
    if (!list) {
      list = []
      windows.set(bucket, list)
    }
    return list
  }

  // 滑动窗口：只保留「仍可能在窗口内」的占位。未来时刻（已排队未放行）必须保留。
  function pruned(list, t) {
    const cutoff = t - windowMs
    let i = 0
    while (i < list.length && list[i] <= cutoff) i++
    if (i > 0) list.splice(0, i)
    return list
  }

  function dailyBlock(key, t) {
    if (!dailyGuard) return null
    const entry = daily.get(String(key ?? ""))
    if (!entry) return null
    if (entry.remaining > 0) return null
    if (entry.resetsAt !== null && entry.resetsAt <= t) {
      // 窗口已跨过重置时刻：额度回来了，清掉旧快照。
      daily.delete(String(key ?? ""))
      return null
    }
    return { reason: "daily-exhausted", remaining: entry.remaining, resetsAt: entry.resetsAt }
  }

  async function take(key) {
    const t = now()
    const blocked = dailyBlock(key, t)
    if (blocked) {
      counters.blocked++
      return { allowed: false, ...blocked, key: String(key ?? "") }
    }

    const k = String(key ?? "") || GLOBAL
    let at = t

    // ① 间隔闸（同一 key 独立时间轴；interval=0 时完全不参与计算）
    if (requestIntervalMs > 0) {
      const last = axes.get(k)
      if (last !== undefined && last + requestIntervalMs > at) at = last + requestIntervalMs
    }

    // ② 滑动窗口配额（同步占位，先算槽位再入表）
    if (freeRpmLimit > 0) {
      const list = pruned(windowOf(bucketOf(key)), t)
      if (list.length >= freeRpmLimit) {
        // 窗口满：等到最早那笔滑出窗口
        const freeAt = list[list.length - freeRpmLimit] + windowMs
        if (freeAt > at) at = freeAt
      }
      list.push(at)
      list.sort((a, b) => a - b)
    }

    axes.set(k, at)
    counters.taken++
    const waitMs = at - t
    // 抖动只叠加在睡眠上（不污染窗口槽位/时间轴）：把固定间隔打散成随机分布。
    const jitter = requestJitterMs > 0 ? doRandom() * requestJitterMs : 0
    if (waitMs + jitter > 0) {
      counters.waited++
      await doSleep(waitMs + jitter)
    }
    return { allowed: true, waitMs, key: k }
  }

  // refund：429 说明这次没被平台计数，把最近一次占位从窗口里退回去，
  // 避免一次失败又把自己的分钟配额吃掉一格。
  function refund(key) {
    if (freeRpmLimit <= 0) return false
    const list = windowOf(bucketOf(key))
    if (list.length === 0) return false
    list.pop()
    counters.refunded++
    return true
  }

  // noteUsage：magpie 的 usage 报告里 name === "free models" 的窗口就是
  // free_model_daily_requests（limit / amount / resetsAt）。
  function noteUsage(key, report) {
    const k = String(key ?? "")
    if (!k) return false
    const windowsList = Array.isArray(report?.windows) ? report.windows : []
    const free = windowsList.find((w) => w?.name === "free models")
    if (!free) return false
    const limit = Number(free.limit)
    const used = Number(free.amount ?? 0)
    const remaining = Number.isFinite(limit) && Number.isFinite(used) ? Math.max(0, limit - used) : null
    if (remaining === null) return false
    const resetsAt = typeof free.resetsAt === "string" ? Date.parse(free.resetsAt) : null
    daily.set(k, { remaining, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null })
    return true
  }

  // noteDaily 是 noteUsage 的直给版本（导入/探测/测试可跳过 usage 报告直接喂数）。
  function noteDaily(key, remaining, resetsAt = null) {
    const k = String(key ?? "")
    if (!k || !Number.isFinite(remaining)) return false
    daily.set(k, { remaining, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null })
    return true
  }

  function snapshot(t = now()) {
    let used = 0
    const perBucket = {}
    for (const [bucket, list] of windows) {
      const live = pruned([...list], t)
      perBucket[bucket] = live.length
      used += live.length
    }
    const dailyOut = {}
    for (const [k, v] of daily) {
      dailyOut[k] = {
        remaining: v.remaining,
        resetsAt: v.resetsAt === null ? null : new Date(v.resetsAt).toISOString(),
      }
    }
    return {
      requestIntervalMs,
      requestJitterMs,
      freeRpmLimit,
      rpmScope,
      dailyGuard,
      windowMs,
      used,
      remaining: freeRpmLimit > 0 ? Math.max(0, freeRpmLimit - used) : null,
      perBucket,
      axes: axes.size,
      daily: dailyOut,
      counters: { ...counters },
    }
  }

  return { take, refund, noteUsage, noteDaily, snapshot }
}
