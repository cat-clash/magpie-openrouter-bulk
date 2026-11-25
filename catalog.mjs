// OpenRouter prices are USD per token. magpie wants USD per million tokens.
export function perMillion(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw !== "" ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 1e6 * 1e6) / 1e6
}

export function isAlias(id) {
  return typeof id === "string" && id.startsWith("~")
}

// output: "default" keeps text and decision models, "text" keeps text, "all" keeps every modality.
export function keep(entry, { output = "default", includeAliases = false } = {}) {
  if (!entry || typeof entry.id !== "string" || !entry.id) return false
  if (isAlias(entry.id) && !includeAliases) return false
  if (output === "all") return true
  const outputs = entry.architecture?.output_modalities ?? ["text"]
  if (output === "text") return outputs.includes("text")
  return outputs.includes("text") || outputs.includes("decisions")
}

function modalities(entry) {
  const inputs = entry.architecture?.input_modalities ?? ["text"]
  const input = inputs.filter((m) => m && m !== "decisions")
  return { input: input.length ? input : ["text"] }
}

function effortsOf(entry) {
  const list = entry.reasoning?.supported_efforts
  return Array.isArray(list) ? list.filter((e) => typeof e === "string" && e) : []
}

export function decidesOnly(entry) {
  const outputs = entry.architecture?.output_modalities ?? []
  return outputs.length > 0 && outputs.every((m) => m === "decisions")
}

// toModel maps one Models API entry onto the model object magpie reads.
export function toModel(entry, now = Date.now()) {
  const prompt = perMillion(entry.pricing?.prompt)
  const completion = perMillion(entry.pricing?.completion)
  const cacheRead = perMillion(entry.pricing?.input_cache_read)
  const cacheWrite = perMillion(entry.pricing?.input_cache_write)
  const context = entry.top_provider?.context_length || entry.context_length || 8192
  const output = entry.top_provider?.max_completion_tokens
  const params = new Set(entry.supported_parameters ?? [])
  const efforts = effortsOf(entry)
  const reasoning = Boolean(
    entry.reasoning?.mandatory || entry.reasoning?.default_enabled || efforts.some((e) => e !== "none"),
  )
  const decides = decidesOnly(entry)
  const free = !decides && prompt === 0 && completion === 0
  const expired = entry.expiration_date && Date.parse(entry.expiration_date) < now
  const cost =
    prompt !== undefined || completion !== undefined
      ? {
          input: prompt ?? 0,
          output: completion ?? 0,
          ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
          ...(cacheRead !== undefined || cacheWrite !== undefined
            ? { cache: { ...(cacheRead !== undefined ? { read: cacheRead } : {}), ...(cacheWrite !== undefined ? { write: cacheWrite } : {}) } }
            : {}),
        }
      : undefined

  return {
    id: entry.id,
    name: entry.name || entry.id,
    limit: { context, ...(output ? { output } : {}) },
    tool_call: params.has("tools"),
    ...(reasoning ? { reasoning: true } : {}),
    ...(efforts.length ? { variants: Object.fromEntries(efforts.map((e) => [e, {}])) } : {}),
    modalities: modalities(entry),
    ...(cost ? { cost } : {}),
    ...(free ? { free: true } : {}),
    ...(decides ? { decides: true } : {}),
    ...(expired ? { status: "deprecated" } : {}),
    ...(Number.isFinite(entry.created) ? { release_date: new Date(entry.created * 1000).toISOString().slice(0, 10) } : {}),
  }
}

const ORIGIN = "https://openrouter.ai"

// nextLink accepts only the next page OpenRouter itself returns.
export function nextLink(next) {
  if (typeof next !== "string" || !next) return ""
  let url
  try {
    url = new URL(next, ORIGIN)
  } catch {
    return ""
  }
  if (url.origin !== ORIGIN) return ""
  if (!url.pathname.startsWith("/api/v1/models")) return ""
  return url.toString()
}

export const BASE = "https://openrouter.ai/api/v1"
const PAGE = 200
const MAX_PAGES = 20

export async function fetchCatalog(doFetch, { key, output = "default", includeAliases = false, now = Date.now() } = {}) {
  const headers = { accept: "application/json" }
  if (key) headers.authorization = `Bearer ${key}`
  if (key) {
    const probe = await doFetch(`${BASE}/key`, { headers })
    if (probe.status === 401) {
      throw Object.assign(new Error("OpenRouter rejected this key. Sign in again."), { signIn: "expired" })
    }
  }

  const first = new URL(`${BASE}/models`)
  first.searchParams.set("limit", String(PAGE))
  first.searchParams.set("output_modalities", "all")
  let next = first.toString()
  const models = {}
  for (let page = 0; page < MAX_PAGES && next; page++) {
    const res = await doFetch(next, { headers })
    if (res.status === 401) {
      throw Object.assign(new Error("OpenRouter rejected this key. Sign in again."), { signIn: "expired" })
    }
    if (!res.ok) throw new Error(`OpenRouter models answered ${res.status}`)
    const body = await res.json()
    for (const entry of body.data ?? []) {
      if (!keep(entry, { output, includeAliases })) continue
      models[entry.id] = toModel(entry, now)
    }
    const more = nextLink(body.links?.next)
    if (more && more === next) throw new Error("OpenRouter model list repeated a page")
    next = more
  }
  if (next) throw new Error("OpenRouter model list did not finish")
  return models
}
