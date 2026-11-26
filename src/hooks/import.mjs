// src/hooks/import.mjs — auth.import：批量导入 key
//
// 输入支持两种：registrar 导出的 api_keys.json（{"keys":[{key,email}]}）与每行一个 key 的
// 文本（# 注释、空行、逗号/分号/空白分隔都接受）。单次最多 100 条（magpie 上限）。
//
// 两条历史契约不能破：
//   1. 成功项**必须**是顶层 `key` —— magpie 的 keptAs() 只认 {refresh|key|access}，
//      `{auth:{key}}` 会被整条丢弃，报 "gave nothing to keep"（BUG #3）。
//   2. metadata.email 是 settle() 判断「同一账号」的稳定标识 —— 丢了它每次重导都会变成
//      新账号，账号池翻倍。

import {
  BASE,
  KEY_RE,
  MAX_IMPORT,
  PROVIDER,
  VERIFY_RETRY_DELAYS,
  VERIFY_TIMEOUT,
  shortId,
} from "../context.mjs"

// parseKeyEntries keeps the registrar's email beside each key.
export function parseKeyEntries(text) {
  const raw = String(text ?? "")
  // 支持 registrar 导出的 api_keys.json：{"keys":[{"key":"sk-or-…","email":…}]}
  if (raw.trimStart().startsWith("{")) {
    try {
      const data = JSON.parse(raw)
      const source = Array.isArray(data?.keys) ? data.keys : []
      const seen = new Set()
      const entries = []
      for (const entry of source) {
        const key = typeof entry === "string" ? entry : entry?.key
        if (typeof key !== "string" || !KEY_RE.test(key) || seen.has(key)) continue
        seen.add(key)
        const email = typeof entry?.email === "string" ? entry.email.trim() : ""
        entries.push({ key, email })
      }
      if (entries.length > 0) return entries
    } catch {
      // 非法 JSON，退回按行解析
    }
  }
  const lines = raw.split(/\r?\n/)
  const seen = new Set()
  const entries = []
  for (const line0 of lines) {
    const line = line0.trim()
    if (!line || line.startsWith("#")) continue
    for (const token of line.split(/[\s,;]+/)) {
      const key = token.trim()
      if (!KEY_RE.test(key) || seen.has(key)) continue
      seen.add(key)
      entries.push({ key, email: "" })
    }
  }
  return entries
}

export function parseKeyText(text) {
  return parseKeyEntries(text).map((entry) => entry.key)
}

async function errorReason(res) {
  try {
    const body = await res.json()
    const message = body?.error?.message ?? body?.message
    return typeof message === "string" && message ? message.slice(0, 200) : ""
  } catch {
    return ""
  }
}

// keyFacts 把 GET /key 的额度快照记进 import metadata，账本不用再打一次请求。
export function keyFacts(data) {
  if (!data || typeof data !== "object") return {}
  const facts = {}
  const round = (n) => Math.round(n * 1e4) / 1e4
  if (typeof data.limit === "number") facts.limit = round(data.limit)
  if (typeof data.limit_remaining === "number") facts.limit_remaining = round(data.limit_remaining)
  if (typeof data.usage === "number") facts.usage = round(data.usage)
  if (typeof data.is_free_tier === "boolean") facts.free_tier = data.is_free_tier
  const free = data.free_model_daily_requests
  if (free && typeof free.limit === "number") facts.free_daily_limit = free.limit
  if (typeof data.label === "string" && data.label) facts.label = data.label
  return facts
}

// verifyKey 单把 key 探一次 GET /key：15s 硬超时（一把挂死的 key 曾拖住整批），
// 429/5xx 重试两档。返回 /key 的 data。调用方需要的话自己接 AbortSignal。
export async function verifyKey(key, { signal } = {}) {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  signal?.addEventListener?.("abort", onAbort)
  const timer = setTimeout(() => ctl.abort(), VERIFY_TIMEOUT)
  try {
    let res
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${BASE}/key`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctl.signal,
      })
      const transient = res.status === 429 || res.status >= 500
      if (!transient || attempt >= VERIFY_RETRY_DELAYS.length) break
      await new Promise((resolve) => setTimeout(resolve, VERIFY_RETRY_DELAYS[attempt]))
    }
    if (res.status === 401 || res.status === 403) {
      const reason = await errorReason(res)
      throw new Error(`key rejected (HTTP ${res.status}${reason ? `: ${reason}` : ""})`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    try {
      return (await res.json())?.data
    } catch {
      return undefined
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", onAbort)
  }
}

export async function importKeys(entries, { signal, verify } = {}) {
  // Accept both {key,email} entries and bare key strings (older callers/tests).
  const items = entries.map((entry) => (typeof entry === "string" ? { key: entry, email: "" } : entry))
  const out = []
  const verifyFn = verify === false ? null : (key) => verifyKey(key, { signal })
  const queue = [...items]
  const workers = Array.from({ length: Math.min(8, items.length) }, async () => {
    while (queue.length > 0 && !signal?.aborted) {
      const { key, email } = queue.shift()
      const accountId = shortId(key)
      try {
        const info = verifyFn ? await verifyFn(key) : null
        out.push({
          type: "success",
          key,
          provider: PROVIDER,
          accountId,
          metadata: { provider: PROVIDER, email: email || accountId, ...(info ? keyFacts(info) : {}) },
        })
      } catch (err) {
        out.push({ type: "failed", error: String(err?.message ?? err), accountId })
      }
    }
  })
  await Promise.all(workers)
  return out
}

// importHook 把上面三步装成 magpie 的 auth.import 钩子。
export function importHook(options) {
  return async (texts, { signal } = {}) => {
    const list = Array.isArray(texts) ? texts : [texts]
    const entries = list.flatMap((t) => parseKeyEntries(t)).slice(0, MAX_IMPORT)
    return await importKeys(entries, { signal, verify: options?.verifyImport !== false })
  }
}
