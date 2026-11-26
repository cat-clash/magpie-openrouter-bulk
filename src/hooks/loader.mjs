// src/hooks/loader.mjs — auth.loader：出站 fetch 的装配点
//
// 职责：把 magpie 交给我们的 (input, init) 先经 request.prepare()（分类器改写到
// Decisions API、按需注入 provider.sort），再交给 failover.fetchWithFailover() 做
// 双维度 429 处理。插件只负责「模型级」那一维；key 级 429 原样透出，由 magpie 把该
// 账号 rest 到重置时刻并在同 provider 的其他账号里换号。
//
// 注意：这里**不做**任何 URL/header 猜测 —— magpie 已经把 authorization 放进 init，
// 我们只补 provider 自定义的两个标记头。

import { BASE, failoverCandidates } from "../context.mjs"
import { fetchWithFailover } from "../../failover.mjs"
import { prepare } from "../../request.mjs"

export function loaderHook(client, options) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (auth?.type !== "api" || !auth.key) return {}
    const referer = options?.referer || "https://usemagpie.ai"
    const title = options?.title || "magpie"
    const candidates = failoverCandidates()
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
  }
}
