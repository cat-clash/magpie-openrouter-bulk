const SORTS = new Set(["price", "throughput", "latency"])
const DECISIONS = "https://openrouter.ai/api/alpha/decisions"

export function requestURL(input) {
  if (typeof input === "string") return input
  if (input && typeof input.url === "string") return input.url
  return ""
}

// OpenRouter's universal decision contract is /api/alpha/decisions with the full model id.
// magpie always posts classifiers to {baseURL}/systemone, which only remaps bare TypeSafe ids.
export function rewriteURL(input) {
  const raw = requestURL(input)
  if (!raw) return raw
  let url
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  if (url.pathname.endsWith("/systemone")) return DECISIONS
  return raw
}

export function withProviderSort(body, sort) {
  if (!SORTS.has(sort) || typeof body !== "string" || !body) return body
  let json
  try {
    json = JSON.parse(body)
  } catch {
    return body
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return body
  if (json.provider?.sort) return body
  return JSON.stringify({ ...json, provider: { ...(json.provider ?? {}), sort } })
}

export function prepare(input, init, { sort } = {}) {
  const url = rewriteURL(input)
  const chat = url.endsWith("/chat/completions")
  const body = chat ? withProviderSort(init?.body, sort) : init?.body
  const headers = new Headers(init?.headers)
  if (body !== init?.body) headers.delete("content-length")
  return { url, init: { ...init, headers, body } }
}
