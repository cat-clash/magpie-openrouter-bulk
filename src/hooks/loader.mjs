// src/hooks/loader.mjs — auth.loader：出站 fetch 的装配点
//
// 职责：把 magpie 交给我们的 (input, init) 先经 request.prepare()（分类器改写到
// Decisions API、按需注入 provider.sort），再过两道闸：
//   ① 风控熔断闸（risk.mjs）：该账号连续遇到**非预期**失败（不是 free-models-per-day
//      日额度耗尽）时，本地 fail-fast —— 发请求前先查 shouldGate()，正在冷却就合成一个
//      429（带 retry-after）交给 magpie 换账号，**一个上游请求都不发**。多个账号同时被
//      拦时跨账号共因闸会把整个池短暂冷却，避免 58 个账号挨个撞墙刷出一片 429。
//   ② 节奏闸（pacing.mjs）：间隔 + 抖动 + 分钟配额 + 日额度短路。
// 之后才交给 failover.fetchWithFailover() 做双维度 429 处理。插件只负责「模型级」那
// 一维；key 级 429 原样透出，由 magpie 把该账号 rest 到重置时刻并在同 provider 的其他
// 账号里换号。
//
// 注意：这里**不做**任何 URL/header 猜测 —— magpie 已经把 authorization 放进 init，
// 我们只补 provider 自定义的两个标记头。

import { BASE, failoverCandidates } from "../context.mjs"
import { fetchWithFailover } from "../../failover.mjs"
import { prepare } from "../../request.mjs"
import {
  accountKeyOf,
  accountLabelOf,
  addPersistedModelCooldown,
  shouldGate,
} from "../risk.mjs"

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

// riskGateResponse：熔断 fail-fast 用的合成 429。刻意**不用** free-models-per-day
// 标记（避开 magpie 对 key 级 429 的 +35 天 rest bug，见 KNOWN_ISSUES BUG #1），
// 而是带 retry-after（= 剩余冷却，clamp 到 retryAfterCap 300s）+ 可读文案，让 magpie
// 把该账号短暂 rest 后换下一个账号。
function riskGateResponse(bucket, retryAfterMs) {
  const retrySeconds = Math.max(1, Math.min(300, Math.ceil(retryAfterMs / 1000)))
  const body = JSON.stringify({
    error: {
      code: 429,
      message: "Rate limit exceeded: risk-gated (circuit breaker) in magpie-openrouter-bulk.",
      metadata: { source: "magpie-openrouter-bulk/risk", bucket, retryAfterMs },
    },
  })
  const headers = {
    "content-type": "application/json",
    "retry-after": String(retrySeconds),
    "x-ratelimit-reset": String(Date.now() + retrySeconds * 1000),
  }
  return new Response(body, { status: 429, statusText: "Too Many Requests", headers })
}

export function loaderHook(client, options, pacer) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (auth?.type !== "api" || !auth.key) return {}
    const referer = options?.referer || "https://usemagpie.ai"
    const title = options?.title || "magpie"
    const candidates = failoverCandidates()
    const bucket = accountKeyOf(auth.key)
    const label = accountLabelOf(auth.key)
    return {
      baseURL: BASE,
      apiKey: auth.key,
      headers: {
        "HTTP-Referer": referer,
        "X-OpenRouter-Title": title,
        "X-Title": title,
      },
      async fetch(input, init) {
        // ① 风控熔断闸：账号在冷却 → fail-fast，不发上游请求。
        const gate = shouldGate(bucket, label)
        if (gate.gate) {
          try {
            console.log(`[plugin] [${"openrouter-live"}] breaker: gate ${label} cooldown ${gate.retryAfterMs}ms`)
          } catch {
            /* ignore */
          }
          return riskGateResponse(bucket, gate.retryAfterMs)
        }
        // ② 节奏闸：先占位（间隔 + 分钟配额），日额度用尽时连包都不发。
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
          // 模型被冷却 → 落盘持久化（重启不丢，见 src/risk.mjs）
          onModelCooldown: (model, untilMs) => addPersistedModelCooldown(model, untilMs),
          // 429 分类完成 → 熔断器记录：key 级日额度耗尽算"正常"，model/other 算风险失败
          onClassified: (info) => {
            const breaker = gate.breaker
            if (info.kind === "key") breaker.record(true)
            else breaker.record(false)
          },
        })
        // 429 没被平台计数：把刚占的分钟配额退回去，别让失败吃掉自己的额度。
        if (res?.status === 429 && pacer) pacer.refund(auth.key)
        // 熔断记录：2xx 清零；非 429 的非 2xx（401/403/404/5xx）累积失败 ——
        // 429 已在 onClassified 里按维度记过（key 级日额度耗尽算 true，model/other 算 false）。
        if (res) {
          if (res.status >= 200 && res.status < 300) gate.breaker.record(true)
          else if (res.status !== 429) gate.breaker.record(false)
        }
        return res
      },
    }
  }
}
