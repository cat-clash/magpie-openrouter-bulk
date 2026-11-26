// src/hooks/usage.mjs — auth.usage：每账号配额窗口 + 账号自动命名
//
// readUsageCached 负责全局并发闸（3）、抖动、8s 超时、429/5xx 退避与 10 分钟缓存，
// 否则 GUI 刷一次就会对 50 个账号各打一次 OpenRouter（per-IP 突发限流）。
//
// rememberName：GET /key 的 name 字段是账号的稳定标识（如 "work"）。magpie 的账号
// 卡片用 metadata.email 当显示名，所以把 name 写回 metadata 一次，GUI 里就不再是长邮箱。

import { PROVIDER } from "../context.mjs"
import { readUsageCached } from "../../usage.mjs"

export async function rememberName(client, auth, name) {
  if (!name || auth?.metadata?.email === name || typeof client?.auth?.set !== "function") return
  await client.auth.set({
    path: { id: PROVIDER },
    body: { ...auth, metadata: { ...(auth.metadata ?? {}), email: name } },
  })
}

export function usageHook(client) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (auth?.type !== "api" || !auth.key) return { error: "OpenRouter has no key for this account", windows: [] }
    const report = await readUsageCached(fetch, auth.key)
    if (report.user) {
      try {
        await rememberName(client, auth, report.user)
      } catch {
        // Naming the account is optional. The quota line still shows report.user.
      }
    }
    return report
  }
}
