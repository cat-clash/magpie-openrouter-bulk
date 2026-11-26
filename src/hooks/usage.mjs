// src/hooks/usage.mjs — auth.usage：每账号配额窗口 + 账号自动命名 + 面板快照
//
// readUsageCached 负责全局并发闸（3）、抖动、8s 超时、429/5xx 退避与 10 分钟缓存，
// 否则 GUI 刷一次就会对 50 个账号各打一次 OpenRouter（per-IP 突发限流）。
//
// rememberName：GET /key 的 name 字段是账号的稳定标识。magpie 的账号卡片用
// metadata.email 当显示名，所以把 name 写回 metadata 一次，GUI 里就不再是长邮箱。
//
// 面板快照：每次 usage 都把该账号的额度并入模块级池，并写 panel/pool-state.js。
// 面板在 sandbox 里没有网络，只能读这个文件 —— 所以「quota 刷新一次，面板就有数据」。

import { readFile } from "node:fs/promises"
import { PROVIDER } from "../context.mjs"
import { readUsageCached } from "../../usage.mjs"
import { STATE_FILE, poolEntry, writePoolState } from "./poolstate.mjs"

/** 账号池快照（key = 账号 user/email）。进程重启后从 pool-state.js 恢复。 */
const pool = new Map()
let restored = false

async function restorePool() {
  if (restored) return
  restored = true
  try {
    const text = await readFile(STATE_FILE, "utf8")
    const m = text.match(/globalThis\.__OR_POOL__\s*=\s*(\{[\s\S]*\});/)
    if (!m) return
    const data = JSON.parse(m[1])
    for (const a of data.accounts || []) {
      if (a && a.user) pool.set(a.user, a)
    }
  } catch {
    // 没有旧快照是正常的（首次运行）
  }
}

export async function rememberName(client, auth, name) {
  if (!name || auth?.metadata?.email === name || typeof client?.auth?.set !== "function") return
  await client.auth.set({
    path: { id: PROVIDER },
    body: { ...auth, metadata: { ...(auth.metadata ?? {}), email: name } },
  })
}

export function usageHook(client, pacer) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (auth?.type !== "api" || !auth.key) return { error: "OpenRouter has no key for this account", windows: [] }
    const report = await readUsageCached(fetch, auth.key)

    // 把「free models」窗口的剩余额度喂给节奏闸：剩 0 时 loader 直接短路不发请求。
    try {
      pacer?.noteUsage?.(auth.key, report)
    } catch {
      // 节奏闸是可选增强，喂数失败不影响配额展示。
    }

    // 面板快照：并入账号池并落盘（失败不影响配额返回）
    try {
      await restorePool()
      const user = report.user || auth?.metadata?.email || "?"
      pool.set(user, poolEntry(user, report))
      await writePoolState([...pool.values()])
    } catch {
      // 面板只是锦上添花
    }

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

/** 供测试/诊断：当前池快照 */
export function poolSnapshot() {
  return [...pool.values()]
}