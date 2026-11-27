// src/hooks/models.mjs — provider.models：动态目录 + 静态兜底
//
// 三态降级：
//   ① 有 key 且目录可用 → 用 /models 实时目录（整表替换静态表）
//   ② 拉不到（离线 / 5xx / 空目录）→ 用静态表并打 magpie.fellBack 标记
//   ③ key 被拒（401）→ 抛 signIn: "expired"，让 magpie 走重新登录
//
// 目录缓存以 (output, includeAliases) 为键、10 分钟 TTL 跨账号共享：50 个账号刷新一次
// 不该等于 50 次 /models（每个最多 21 页）。命中缓存时仍逐个探测账号 key。

import { BASE, CATALOG_TTL, DEAD_MODELS } from "../context.mjs"
import { fetchCatalog } from "../../catalog.mjs"

// cache key -> { at, models }
const catalogCache = new Map()

export function clearCatalogCache() {
  catalogCache.clear()
}

// usable 把「免费号真能调用」与「只显示实测健康模型」两个开关叠到模型表上。
// 两个开关都关时**必须原样返回同一个对象**（magpie 会比对引用判断有无变化）。
function usable(models, options) {
  const freeOnly = options?.freeOnly === true
  const healthyOnly = options?.healthyModelsOnly === true
  if (!freeOnly && !healthyOnly) return models
  // 允许注入死模型集合（默认用内置 DEAD_MODELS，现为空 —— 2026-11-27 复测全通）
  const dead = Array.isArray(options?.deadModels) ? new Set(options.deadModels) : DEAD_MODELS
  const out = {}
  for (const [id, model] of Object.entries(models)) {
    if (freeOnly && !(model?.free === true || id === "openrouter/auto")) continue
    if (healthyOnly && dead.has(id)) continue
    out[id] = model
  }
  return out
}

export function modelsHook(options) {
  return async (provider, { auth } = {}) => {
    if (auth?.type !== "api" || !auth.key) return usable(provider.models, options)
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
      return { ...usable(hit.models, options) }
    }
    try {
      const listed = await fetchCatalog(fetch, {
        key: auth.key,
        output: options?.output,
        includeAliases: options?.includeAliases === true,
      })
      if (Object.keys(listed).length === 0) {
        const fallback = usable({ ...provider.models }, options)
        fallback[Symbol.for("magpie.fellBack")] = true
        return fallback
      }
      // Cache the full catalog and filter on the way out, so switching
      // freeOnly does not refetch /models.
      catalogCache.set(ck, { at: Date.now(), models: listed })
      return usable(listed, options)
    } catch (err) {
      if (err?.signIn === "expired") throw err
      return usable(provider.models, options)
    }
  }
}
