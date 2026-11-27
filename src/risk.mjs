// src/risk.mjs — 风控熔断层（语义移植自 magpie-marvis 0.8.x 的 breaker.mjs）
//
// 背景（issue: 58 账号池「总是限流」）：
//   · 节奏闸（pacing.mjs）只负责把单账号的出站节奏拉开、日额度用尽时短路 —— 是"预防"。
//   · 熔断器负责"止损"：当某账号连续遇到**非预期**失败（不是正常的 free-models-per-day
//     日额度耗尽，而是 401 / 上游限流 / 5xx / 网络错）时，本地直接拒绝一段时间（fail-fast），
//     不再让 magpie 宿主对它连试 7 次 —— 密集重试恰恰会拉长 OpenRouter/Cloudflare 的
//     限流冷却（实测教训与 marvis issue #71 一致）。
//   · 跨账号共因闸：如果**多个不同账号**在短时间内先后被拦，说明拦的不是账号而是通道
//     （出口 IP / 上游节点被 throttled）→ 自动把全局桶打开，整个池 fail-fast 冷却，
//     而不是让 58 个账号挨个撞墙（这正是"界面上一片 429"的来源）。
//
// 语义要点：
//   · 按账号分桶（OPENROUTER_RISK_SCOPE=account 默认）：一个账号被打只冷却这个账号，
//     兄弟账号照常出网；global 找回旧的"一个号出事全停"。
//   · 指数退避：冷却 = base * 2^consecutiveOpens，封顶 8h，每次熔断叠加 ±10% jitter
//     （多进程同时苏醒会形成请求尖峰，jitter 错开苏醒时刻）。
//   · 半开（half-open）：冷却到期后放行探测请求，第一个落地结果统一判定 —— 成功关闭并
//     清零，失败立即重开、退避翻倍。
//   · 持久化到稳定目录 <dir>/breaker-state.json（重启不丢）；损坏 JSON 当无状态。
//   · record(true) 只该在"账号真的健康/正常日额度耗尽"时调用；record(false) 只该在
//     **非预期**失败时调用（free-models-per-day 的 429 是正常耗尽，算 true）。
//
// 环境变量（默认值）：
//   OPENROUTER_RISK_DIR           稳定目录（默认 ~/.magpie-openrouter-bulk）
//   OPENROUTER_RISK_THRESHOLD     连续失败阈值（3）
//   OPENROUTER_RISK_COOLDOWN_MS   退避基准（1_800_000 = 30min；0 = 禁用熔断）
//   OPENROUTER_RISK_SCOPE         account | global
//   OPENROUTER_RISK_CONSENSUS     窗口内不同账号被拦达到几个判共因（2；0 = 关共因闸）
//   OPENROUTER_RISK_WINDOW_MS     共因判定窗口（600_000 = 10min）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

const DEFAULT_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 1_800_000
const MAX_COOLDOWN_MS = 8 * 60 * 60 * 1_000 // 指数退避上限 8h
const CLOCK_SKEW_MS = 5 * 60 * 1_000 // openedAt 领先当前 5min = 时钟偏移，忽略冷却
const MAX_EVENTS = 50
const JITTER_RATIO = 0.1
const DEFAULT_CONSENSUS = 2
const DEFAULT_CONSENSUS_WINDOW_MS = 10 * 60 * 1_000
const GLOBAL_BUCKET = "*"

function intEnv(name, fallback, { allowZero = false } = {}) {
  const raw = Number.parseInt(String(process.env[name] ?? ""), 10)
  const ok = Number.isFinite(raw) && (allowZero ? raw >= 0 : raw > 0)
  return ok ? raw : fallback
}

function numEnv(name, fallback) {
  const raw = Number.parseFloat(String(process.env[name] ?? ""))
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

function clampInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
}

/** 稳定目录：每次解析、不缓存（测试会改 OPENROUTER_RISK_DIR） */
export function resolveRiskDir() {
  const envDir = process.env.OPENROUTER_RISK_DIR
  if (envDir && envDir.trim()) return envDir
  return join(homedir(), ".magpie-openrouter-bulk")
}

function stateFilePath() {
  return join(resolveRiskDir(), "breaker-state.json")
}

export function breakerStatePath() {
  return stateFilePath()
}

export function riskScope() {
  const v = String(process.env.OPENROUTER_RISK_SCOPE ?? "").trim().toLowerCase()
  return v === "global" ? "global" : "account"
}

function consensusConfig() {
  return {
    n: intEnv("OPENROUTER_RISK_CONSENSUS", DEFAULT_CONSENSUS, { allowZero: true }),
    windowMs: intEnv("OPENROUTER_RISK_WINDOW_MS", DEFAULT_CONSENSUS_WINDOW_MS),
  }
}

/** key → 桶：稳定短哈希，不落 key 明文 */
export function accountKeyOf(key) {
  const raw = String(key ?? "").trim()
  if (!raw) return GLOBAL_BUCKET
  return createHash("sha256").update(raw).digest("hex").slice(0, 12)
}

/** key → 可读标签（脱敏），只用于 CLI 与报错文案 */
export function accountLabelOf(key) {
  const raw = String(key ?? "").trim()
  if (!raw) return "未指定账号"
  if (raw.startsWith("sk-or-")) return `sk-or-…${raw.slice(-6)}`
  return raw.length <= 12 ? raw : `${raw.slice(0, 4)}…${raw.slice(-4)}`
}

function readState() {
  try {
    const data = JSON.parse(readFileSync(stateFilePath(), "utf8"))
    if (!data || typeof data !== "object") return {}
    if (data.version === 2 && data.accounts && typeof data.accounts === "object") {
      const out = {}
      for (const [k, v] of Object.entries(data.accounts)) {
        if (!v || typeof v !== "object") continue
        if (
          k === GLOBAL_BUCKET &&
          !v.reason &&
          riskScope() !== "global" &&
          Number(v.openedAt) > 0
        ) {
          out[k] = { ...v, openedAt: 0, stale: true }
        } else {
          out[k] = v
        }
      }
      return out
    }
    if ("consecutiveOpens" in data || "openedAt" in data || "failures" in data) {
      const opened = Number(data.openedAt)
      return {
        [GLOBAL_BUCKET]: {
          consecutiveOpens: clampInt(data.consecutiveOpens),
          openedAt: Number.isFinite(opened) ? opened : 0,
          failures: clampInt(data.failures),
          v1: true,
        },
      }
    }
    return {}
  } catch {
    return {}
  }
}

function writeState(accounts) {
  try {
    mkdirSync(resolveRiskDir(), { recursive: true })
    writeFileSync(stateFilePath(), JSON.stringify({ version: 2, accounts }))
  } catch {
    /* 写盘失败不影响请求路径 */
  }
}

/** 诊断 / CLI：所有桶 {bucket, label, failures, openedAt, consecutiveOpens, retryAfterMs} */
export function breakerBuckets(nowMs = Date.now()) {
  const all = readState()
  return Object.entries(all).map(([bucket, s]) => {
    const openedAt = clampInt(s.openedAt)
    const failures = clampInt(s.failures)
    const consecutiveOpens = clampInt(s.consecutiveOpens)
    const base = intEnv("OPENROUTER_RISK_COOLDOWN_MS", DEFAULT_COOLDOWN_MS, { allowZero: true })
    let retryAfterMs = 0
    if (openedAt > 0 && base > 0) {
      const capped = Math.min(base * 2 ** consecutiveOpens, MAX_COOLDOWN_MS)
      retryAfterMs = Math.max(0, capped - (nowMs - openedAt))
    }
    return {
      bucket,
      label: typeof s.label === "string" && s.label ? s.label : bucket === GLOBAL_BUCKET ? "全局" : bucket,
      failures,
      consecutiveOpens,
      openedAt,
      retryAfterMs,
    }
  })
}

/**
 * 单桶熔断器。opts:
 *   threshold / cooldownMs / now / random / bucket / label / onOpen
 */
export function createBreaker({
  threshold = DEFAULT_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now,
  random = Math.random,
  bucket = GLOBAL_BUCKET,
  label = "",
  onOpen,
} = {}) {
  threshold = intEnv("OPENROUTER_RISK_THRESHOLD", threshold)
  cooldownMs = intEnv("OPENROUTER_RISK_COOLDOWN_MS", cooldownMs, { allowZero: true })
  bucket = String(bucket || GLOBAL_BUCKET)

  let failures = 0
  let consecutiveOpens = 0
  let openedAt = 0
  let halfOpen = false
  let activeCooldown = 0
  let loaded = false
  let tripReason = ""
  const events = []

  function computeCooldown(consecutive) {
    const capped = Math.min(cooldownMs * 2 ** consecutive, MAX_COOLDOWN_MS)
    const jitter = (random() * 2 - 1) * capped * JITTER_RATIO
    return Math.max(0, capped + jitter)
  }

  function pushEvent(type, cooldownMsValue) {
    events.push({ at: now(), type, cooldownMs: cooldownMsValue })
    if (events.length > MAX_EVENTS) events.shift()
  }

  function loadState() {
    if (loaded) return
    loaded = true
    try {
      const data = readState()[bucket]
      if (!data || typeof data !== "object") return
      consecutiveOpens = clampInt(data.consecutiveOpens)
      failures = clampInt(data.failures)
      if (data.v1 || data.stale) return
      tripReason = typeof data.reason === "string" ? data.reason : ""
      const opened = Number(data.openedAt)
      if (Number.isFinite(opened) && opened > 0) {
        const age = now() - opened
        if (age < -CLOCK_SKEW_MS || age > MAX_COOLDOWN_MS) {
          openedAt = 0
          return
        }
        openedAt = opened
      }
    } catch {
      /* 损坏 JSON / 目录不存在：当无状态 */
    }
  }

  function persist() {
    const all = readState()
    const entry = { consecutiveOpens, openedAt, failures }
    if (label) entry.label = label
    else if (all[bucket]?.label) entry.label = all[bucket].label
    if (tripReason) entry.reason = tripReason
    if (events.length) entry.events = events.slice(-20)
    all[bucket] = entry
    writeState(all)
  }

  function expireIfDue() {
    if (!openedAt || halfOpen) return
    if (!activeCooldown) activeCooldown = computeCooldown(consecutiveOpens)
    if (now() - openedAt >= activeCooldown) halfOpen = true
  }

  function openBreaker(fromProbe) {
    if (fromProbe) {
      consecutiveOpens += 1
      pushEvent("probe-fail", 0)
    }
    openedAt = now()
    halfOpen = false
    activeCooldown = computeCooldown(consecutiveOpens)
    pushEvent(fromProbe ? "reopen" : "open", activeCooldown)
    persist()
    if (typeof onOpen === "function") {
      try {
        onOpen({ bucket, at: openedAt })
      } catch {
        /* 回调失败不影响熔断 */
      }
    }
  }

  function closeBreaker() {
    openedAt = 0
    halfOpen = false
    activeCooldown = 0
    failures = 0
    consecutiveOpens = 0
    tripReason = ""
    pushEvent("close", 0)
    persist()
  }

  return {
    get open() {
      loadState()
      if (cooldownMs <= 0) return false
      expireIfDue()
      return openedAt > 0 && !halfOpen
    },
    get retryAfterMs() {
      loadState()
      if (cooldownMs <= 0) return 0
      expireIfDue()
      if (!openedAt || halfOpen) return 0
      if (!activeCooldown) activeCooldown = computeCooldown(consecutiveOpens)
      return Math.max(0, activeCooldown - (now() - openedAt))
    },
    get failures() {
      loadState()
      return failures
    },
    get consecutiveOpens() {
      loadState()
      return consecutiveOpens
    },
    record(ok) {
      loadState()
      expireIfDue()
      if (cooldownMs <= 0) {
        if (ok) {
          if (failures !== 0) {
            failures = 0
            persist()
          }
        } else {
          failures += 1
          persist()
        }
        return
      }
      if (ok) {
        if (openedAt || halfOpen) closeBreaker()
        else if (failures !== 0) {
          failures = 0
          persist()
        }
        return
      }
      failures += 1
      if (halfOpen) {
        openBreaker(true)
        return
      }
      if (failures >= threshold && !openedAt) openBreaker(false)
      else persist()
    },
    reset() {
      loadState()
      closeBreaker()
    },
    trip(reason = "external") {
      loadState()
      expireIfDue()
      if (cooldownMs <= 0) return
      if (openedAt && !halfOpen) return
      openedAt = now()
      halfOpen = false
      activeCooldown = computeCooldown(consecutiveOpens)
      tripReason = String(reason) || "external"
      pushEvent(tripReason, activeCooldown)
      persist()
    },
    events(limit = MAX_EVENTS) {
      loadState()
      const n = Math.trunc(Math.min(limit, MAX_EVENTS))
      if (n <= 0) return []
      return events.slice(-n)
    },
  }
}

// ---- 进程级按账号分桶的池 + 跨账号共因闸 ----

const pool = new Map()
const labels = new Map()
const tripLog = []

function noteBucketTrip(bucketName) {
  if (bucketName === GLOBAL_BUCKET) return
  const { n, windowMs } = consensusConfig()
  if (n <= 0) return
  const t = Date.now()
  tripLog.push({ bucket: bucketName, at: t })
  while (tripLog.length && t - tripLog[0].at > windowMs) tripLog.shift()
  if (new Set(tripLog.map((e) => e.bucket)).size < n) return
  tripLog.length = 0
  getBreaker(GLOBAL_BUCKET, "跨账号共因").trip("cross-account")
}

export function getBreaker(bucket = GLOBAL_BUCKET, label = "", opts = {}) {
  const key = String(bucket || GLOBAL_BUCKET)
  if (label) labels.set(key, label)
  let b = pool.get(key)
  if (!b) {
    b = createBreaker({
      ...opts,
      bucket: key,
      label: labels.get(key) ?? "",
      onOpen: () => noteBucketTrip(key),
    })
    pool.set(key, b)
  }
  return b
}

export function resetAllBreakers() {
  const keys = new Set([...Object.keys(readState()), ...pool.keys()])
  for (const k of keys) getBreaker(k).reset()
  tripLog.length = 0
  return keys.size
}

export const riskBreaker = getBreaker(GLOBAL_BUCKET)

export function riskEvents(limit = MAX_EVENTS) {
  return riskBreaker.events(limit)
}

export function riskEventsOf(bucket = GLOBAL_BUCKET, limit = MAX_EVENTS) {
  return getBreaker(bucket).events(limit)
}

// ---- 账号熔断的「门前检查」助手 ----
// loader 在发请求前调 shouldGate(bucket)：
//   · 返回 { gate: true, bucket, retryAfterMs, label, reason } → 该账号**或全局桶**正在
//     冷却，fail-fast —— 本地合成一个 429（带 retry-after，见 loader 的 riskGateResponse），
//     不发出网。reason="account" 是账号自身被拦；reason="cross-account" 是跨账号共因闸
//     判定通道（IP/上游节点）被封、整个池暂停。
//   · 返回 { gate: false, breaker } → 正常出网（breaker 供 loader 记结果用）。
// 全局桶被共因闸打开时，所有账号都 gate（pool-wide fail-fast）—— 这正是
// 「58 个账号挨个撞墙刷出一片 429」的正确解法。
export function shouldGate(bucket, label = "") {
  const br = getBreaker(bucket, label)
  if (br.open) return { gate: true, breaker: br, bucket, retryAfterMs: br.retryAfterMs, label, reason: "account" }
  const global = getBreaker(GLOBAL_BUCKET)
  if (global.open) return { gate: true, breaker: br, bucket: GLOBAL_BUCKET, retryAfterMs: global.retryAfterMs, label: "全局(跨账号共因)", reason: "cross-account" }
  return { gate: false, breaker: br }
}

// ---- 模型冷却持久化 ----
// 目前 failover.mjs 的模型 cooldown 是纯内存（重启丢）。这里补一层落盘：
// 内存态照旧由 failover 管理，本模块只负责把「仍未到期的冷却」写到 state 文件、
// 启动时灌回内存。这样上游限流的模型跨 magpie 重启依然冷却，不会一重启就立刻再打它。

const MODEL_COOLDOWNS_FILE = "model-cooldowns.json"
const persistedCooldowns = new Map() // model -> until(ms)，进程内托管 + 落盘

export function loadPersistedModelCooldowns(nowMs = Date.now()) {
  try {
    const raw = JSON.parse(readFileSync(join(resolveRiskDir(), MODEL_COOLDOWNS_FILE), "utf8"))
    if (!raw || typeof raw !== "object") return []
    const out = []
    for (const [model, until] of Object.entries(raw)) {
      const untilMs = Number(until)
      if (Number.isFinite(untilMs) && untilMs > nowMs) out.push([model, untilMs])
    }
    return out
  } catch {
    return []
  }
}

export function savePersistedModelCooldowns(entries, nowMs = Date.now()) {
  const keep = {}
  for (const [model, untilMs] of entries) {
    if (model && Number.isFinite(untilMs) && untilMs > nowMs) keep[model] = untilMs
  }
  try {
    mkdirSync(resolveRiskDir(), { recursive: true })
    writeFileSync(join(resolveRiskDir(), MODEL_COOLDOWNS_FILE), JSON.stringify(keep))
  } catch {
    /* 写盘失败不影响请求 */
  }
}

/** 记录一条模型冷却（内存托管 + 落盘）—— loader 的 onModelCooldown 回调接这里 */
export function addPersistedModelCooldown(model, untilMs) {
  if (!model || !Number.isFinite(untilMs)) return
  persistedCooldowns.set(model, untilMs)
  savePersistedModelCooldowns([...persistedCooldowns])
}

/** 启动时把落盘的模型冷却灌回 failover 的内存表（markFn = markModelCooldown） */
export function hydrateModelCooldowns(markFn, nowMs = Date.now()) {
  for (const [model, untilMs] of loadPersistedModelCooldowns(nowMs)) {
    persistedCooldowns.set(model, untilMs)
    try {
      markFn(model, untilMs, nowMs)
    } catch {
      /* 灌入失败不影响 */
    }
  }
  return persistedCooldowns.size
}

export function persistedModelCooldownSnapshot(nowMs = Date.now()) {
  const out = {}
  for (const [m, u] of persistedCooldowns) if (u > nowMs) out[m] = new Date(u).toISOString()
  return out
}

export const _riskInternals = {
  DEFAULT_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  GLOBAL_BUCKET,
  readState,
  noteBucketTrip,
  tripLog,
}

/** 测试复位：清空进程级熔断池 / 共因记录 / 模型冷却托管（只清内存，不删落盘文件） */
export function _resetRiskForTests() {
  pool.clear()
  labels.clear()
  tripLog.length = 0
  persistedCooldowns.clear()
}
