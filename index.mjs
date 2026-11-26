import { BASE, fetchCatalog } from "./catalog.mjs"
import { prepare } from "./request.mjs"
import { clearUsageCache, readUsageCached } from "./usage.mjs"
import {
  DEAD_MODELS,
  fetchWithFailover,
  stats,
  snapshotStats,
  fmtFailover,
  classify429,
  pickCandidate,
} from "./failover.mjs"

const PROVIDER = "openrouter-live"
const ICON = "https://cdn.simpleicons.org/openrouter"

// The model catalog is public and the same for every account. Listing it once
// per account cost 50 x (1 /key probe + up to 20 /models pages) requests on
// every provider refresh. Share one catalog across accounts for a short TTL;
// still check each account's key so a revoked key is reported immediately.
const CATALOG_TTL = 10 * 60 * 1000
const catalogCache = new Map()

const AUTO = {
  name: "OpenRouter Auto",
  limit: { context: 2000000, output: 8192 },
  tool_call: true,
}

// Offline fallback catalog: `openrouter/auto` plus the `:free` / zero-price
// text models OpenRouter actually served when this list was last refreshed
// (2026-11-26, 737 models, 21 `:free`, 12 text-chat usable). The live /models
// listing replaces this whole list whenever a key can reach OpenRouter, so
// this only matters offline, before the first refresh, or on a fresh install
// without a key yet.
const FREE_MODELS = {
  "openrouter/auto": AUTO,
  "baidu/ernie-5.5-flash-preview:free": { name: "Baidu: ERNIE-5.5-Flash-Preview (free)", limit: { context: 1024000, output: 921600 }, tool_call: true, reasoning: true, free: true },
  "google/gemma-4-26b-a4b-it:free": { name: "Google: Gemma 4 26B A4B (free)", limit: { context: 262144, output: 32768 }, tool_call: true, free: true },
  "google/gemma-4-31b-it:free": { name: "Google: Gemma 4 31B (free)", limit: { context: 262144, output: 32768 }, tool_call: true, free: true },
  "inclusionai/ling-3.2-flash:free": { name: "inclusionAI: Ling 3.2 Flash (free)", limit: { context: 1048576, output: 262144 }, tool_call: true, reasoning: true, free: true },
  "liquid/lfm-3-1.7b:free": { name: "LiquidAI: LFM3-1.7B (free)", limit: { context: 262144, output: 8192 }, tool_call: true, reasoning: true, free: true },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { name: "NVIDIA: Nemotron 3 Nano Omni (free)", limit: { context: 256000, output: 65536 }, tool_call: true, reasoning: true, free: true },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { name: "NVIDIA: Nemotron 3 Ultra (free)", limit: { context: 1000000, output: 65536 }, tool_call: true, reasoning: true, free: true },
  "nvidia/nemotron-3.5-lightning:free": { name: "NVIDIA: Nemotron 3.5 Lightning (free)", limit: { context: 1000000, output: 65536 }, tool_call: true, free: true },
  "nvidia/nemotron-3.5-super-vl:free": { name: "NVIDIA: Nemotron 3.5 Super VL (free)", limit: { context: 1000000, output: 131072 }, tool_call: true, free: true },
  "openrouter/free": { name: "Free Models Router", limit: { context: 200000 }, tool_call: true, free: true },
  "particle-ai/particle-1:free": { name: "Particle AI: Particle-1 (free)", limit: { context: 1048576, output: 131072 }, tool_call: true, reasoning: true, free: true },
  "recursive/flint-v1.0:free": { name: "Recursive: Flint (free)", limit: { context: 262144, output: 235929 }, tool_call: true, reasoning: true, free: true },
}

// ---- 批量导入（magpie auth.import 扩展点，单次 ≤100）----
// 输入文本按行解析，支持 # 注释与空行；可选 `verify: false` 关闭逐 key 校验。
const KEY_RE = /^sk-or-[A-Za-z0-9_\-]+$/

// parseKeyEntries keeps the registrar's email beside each key. magpie's
// settle() uses metadata.email as the account's stable identity, so dropping
// it here makes every re-import look like a brand-new account.
function parseKeyEntries(text) {
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

function parseKeyText(text) {
  return parseKeyEntries(text).map((entry) => entry.key)
}

const shortId = (key) => `key-${key.slice(-6)}`

const VERIFY_TIMEOUT = 15000
// 429 / 5xx are transient: two retries (500ms, then 1500ms) before failing.
const VERIFY_RETRY_DELAYS = [500, 1500]

async function errorReason(res) {
  try {
    const body = await res.json()
    const message = body?.error?.message ?? body?.message
    return typeof message === "string" && message ? message.slice(0, 200) : ""
  } catch {
    return ""
  }
}

// keyFacts snapshots the GET /key figures into import metadata, so the ledger
// records what a key was worth at import time without another request later.
function keyFacts(data) {
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

async function importKeys(entries, { signal, verify } = {}) {
  // Accept both {key,email} entries and bare key strings (older callers/tests).
  const items = entries.map((entry) => typeof entry === "string" ? { key: entry, email: "" } : entry)
  const out = []
  const verifyKey = verify === false ? null : async (key) => {
    // Bound each probe: one hung key used to stall the whole batch.
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
  const queue = [...items]
  const workers = Array.from({ length: Math.min(8, items.length) }, async () => {
    while (queue.length > 0 && !signal?.aborted) {
      const { key, email } = queue.shift()
      const accountId = shortId(key)
      try {
        const info = verifyKey ? await verifyKey(key) : null
        // magpie's keptAs() accepts only a TOP-LEVEL `key` (or refresh/access).
        // The old `{ auth: { key } }` shape was rejected for every entry,
        // which produced "gave nothing to keep" / "nothing imported".
        // metadata.email is the stable identity settle() uses to update an
        // existing account instead of adding a duplicate on re-import.
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


async function rememberName(client, auth, name) {
  if (!name || auth?.metadata?.email === name || typeof client?.auth?.set !== "function") return
  await client.auth.set({
    path: { id: PROVIDER },
    body: { ...auth, metadata: { ...(auth.metadata ?? {}), email: name } },
  })
}

export const OpenRouterPlugin = async ({ client } = {}, options) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "OpenRouter",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
      // Classifiers go to loader fetch as POST {baseURL}/systemone. fetch sends them to the Decisions API.
      decide: true,
      models: { ...FREE_MODELS },
    }
  },

  auth: {
    provider: PROVIDER,
    icon: ICON,
    maxConcurrency: 8,
    methods: [{ type: "api", label: "OpenRouter API key", placeholder: "sk-or-v1-…" }],
    // magpie 把这些显示成 provider 编辑器里的开关，用户改完立刻生效（input.magpie.options）。
    options: [
      {
        key: "fallbackToHealthy",
        label: "死模型自动改投健康模型",
        description:
          "请求点到实测全灭的模型（ling-3.2-flash / gemma-4-*）时，直接改投一个健康的免费模型，省一次必 429 的请求。默认关，避免改变你指定的模型语义。",
        default: false,
        labels: { zh: "死模型自动改投健康模型" },
        descriptions: {
          zh: "请求点到实测全灭的模型（ling-3.2-flash / gemma-4-*）时，直接改投一个健康的免费模型，省一次必 429 的请求。默认关，避免改变你指定的模型语义。",
        },
        placement: "top",
      },
      {
        key: "healthyModelsOnly",
        label: "只显示健康模型",
        description:
          "开启后在模型列表里隐藏实测模型级全灭的 ling-3.2-flash 与 gemma-4-*，只暴露 9 个健康免费模型。",
        default: false,
        labels: { zh: "只显示健康模型" },
        descriptions: {
          zh: "开启后在模型列表里隐藏实测模型级全灭的 ling-3.2-flash 与 gemma-4-*，只暴露 9 个健康免费模型。",
        },
        placement: "top",
      },
    ],
    importFrom: { en: "OpenRouter keys.txt (one key per line, # comments)", zh: "OpenRouter keys.txt（每行一个 Key，# 注释）" },
    importFroms: { en: "OpenRouter keys.txt (one key per line)", zh: "OpenRouter keys.txt（每行一个 Key）" },
    async import(texts, { signal } = {}) {
      const list = Array.isArray(texts) ? texts : [texts]
      const entries = list.flatMap((t) => parseKeyEntries(t)).slice(0, 100)
      return await importKeys(entries, { signal, verify: options?.verifyImport !== false })
    },
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      const referer = options?.referer || "https://usemagpie.ai"
      const title = options?.title || "magpie"
      // 模型级 failover 的候选：健康的免费具体模型（排除 openrouter/auto 与
      // openrouter/free 两个路由器——它们既不解决模型级也不解决 key 级 429）。
      const candidates = Object.keys(FREE_MODELS).filter(
        (id) => FREE_MODELS[id].free === true && !id.startsWith("openrouter/") && !DEAD_MODELS.has(id),
      )
      return {
        baseURL: BASE,
        apiKey: auth.key,
        headers: {
          "HTTP-Referer": referer,
          "X-OpenRouter-Title": title,
          "X-Title": title,
        },
        async fetch(input, init) {
          const sent = prepare(input, init, { sort: options?.sort })
          return fetchWithFailover(fetch, sent.url, sent.init, {
            key: auth.key,
            candidates,
            fallbackToHealthy: options?.fallbackToHealthy === true,
            healthyModelsOnly: options?.healthyModelsOnly === true,
            modelCooldownMs: options?.modelCooldownMs,
            maxRetries: options?.maxRetries,
            client,
          })
        },
      }
    },
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return { error: "OpenRouter has no key for this account", windows: [] }
      // readUsageCached caps concurrency (3), jitters, times out (8s), retries
      // 429/5xx with backoff and serves a 10-minute cache so a GUI refresh does
      // not re-hit OpenRouter for every one of the bulk accounts.
      const report = await readUsageCached(fetch, auth.key)
      if (report.user) {
        try {
          await rememberName(client, auth, report.user)
        } catch {
          // Naming the account is optional. The quota line still shows report.user.
        }
      }
      return report
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      // freeOnly keeps just what a free-tier key can actually call: `:free`
      // models and zero-price routers. Paid models need purchased credits
      // (total_credits = 0 on registrar keys), so listing them only invites
      // 402s. openrouter/auto stays because chat routing names it.
      const freeOnly = options?.freeOnly === true
      const healthyOnly = options?.healthyModelsOnly === true
      const usable = (models) => {
        if (!freeOnly && !healthyOnly) return models
        const out = {}
        for (const [id, model] of Object.entries(models)) {
          if (freeOnly && !(model?.free === true || id === "openrouter/auto")) continue
          if (healthyOnly && DEAD_MODELS.has(id)) continue
          out[id] = model
        }
        return out
      }
      if (auth?.type !== "api" || !auth.key) return usable(provider.models)
      const ck = `${options?.output ?? "default"}|${options?.includeAliases === true}`
      const hit = catalogCache.get(ck)
      if (hit && Date.now() - hit.at < CATALOG_TTL) {
        try {
          const probe = await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${auth.key}` } })
          if (probe.status === 401) throw Object.assign(new Error("OpenRouter rejected this key. Sign in again."), { signIn: "expired" })
        } catch (err) {
          if (err?.signIn === "expired") throw err
          // Offline: the shared catalog is still better than the static list.
        }
        return { ...usable(hit.models) }
      }
      try {
        const listed = await fetchCatalog(fetch, {
          key: auth.key,
          output: options?.output,
          includeAliases: options?.includeAliases === true,
        })
        if (Object.keys(listed).length === 0) {
          const fallback = usable({ ...provider.models })
          fallback[Symbol.for("magpie.fellBack")] = true
          return fallback
        }
        // Cache the full catalog and filter on the way out, so switching
        // freeOnly does not refetch /models.
        catalogCache.set(ck, { at: Date.now(), models: listed })
        return usable(listed)
      } catch (err) {
        if (err?.signIn === "expired") throw err
        return usable(provider.models)
      }
    },
  },
})

export const _internal = {
  PROVIDER,
  rememberName,
  parseKeyText,
  parseKeyEntries,
  importKeys,
  clearCatalogCache: () => catalogCache.clear(),
  clearUsageCache: () => clearUsageCache(),
  failover: { stats, snapshotStats, fmtFailover, classify429, pickCandidate, DEAD_MODELS, fetchWithFailover },
}
