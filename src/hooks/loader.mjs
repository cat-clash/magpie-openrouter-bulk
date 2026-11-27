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

// guardResponse 把本地日额度短路翻译成**合成的 key 级 429**：body 里带
// `free-models-per-day`（classify429 判为 key 级），magpie 收到后会把该账号 rest 到
// 重置时刻并换下一个账号 —— 与被上游真拒的效果一致，但省掉一次必然 429 的请求。
function guardResponse(ticket) {
  const resetsAt = ticket?.resetsAt ? new Date(ticket.resetsAt).toISOString() : undefined
  const body = JSON.stringify({
    error: {
      code: 429,
      message: "Rate limit exceeded: free-models-per-day. Local daily guard in magpie-openrouter-bulk.",
      metadata: {
        source: "magpie-openrouter-bulk/pacing",
        reason: ticket?.reason ?? "daily-exhausted",
        remaining: ticket?.remaining ?? 0,
        ...(resetsAt ? { resetsAt } : {}),
      },
    },
  })
  const headers = { "content-type": "application/json" }
  if (resetsAt) headers["x-ratelimit-reset"] = String(Date.parse(resetsAt))
  return new Response(body, { status: 429, statusText: "Too Many Requests", headers })
}

export function loaderHook(client, options, pacer) {
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
        // 节奏闸：先占位（间隔 + 分钟配额），日额度用尽时连包都不发。
        if (pacer) {
          const ticket = await pacer.take(auth.key)
          if (!ticket.allowed) return guardResponse(ticket)
        }
        const sent = prepare(input, init, { sort: options?.sort })
        const res = await fetchWithFailover(fetch, sent.url, sent.init, {
          key: auth.key,
          candidates,
          fallbackToHealthy: options?.fallbackToHealthy === true,
          healthyModelsOnly: options?.healthyModelsOnly === true,
          modelCooldownMs: options?.modelCooldownMs,
          maxRetries: options?.maxRetries,
          // 允许用户/测试注入「全灭模型」名单（默认用内置 DEAD_MODELS，现为空）
          ...(Array.isArray(options?.deadModels) ? { deadModels: new Set(options.deadModels) } : {}),
          client,
        })
        // 429 没被平台计数：把刚占的分钟配额退回去，别让失败吃掉自己的额度。
        if (res?.status === 429 && pacer) pacer.refund(auth.key)
        return res
      },
    }
  }
}
