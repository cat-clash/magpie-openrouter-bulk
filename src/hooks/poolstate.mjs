// src/hooks/poolstate.mjs — 把账号池快照写给 GUI 面板
//
// 面板跑在 sandbox 里（connect-src 'none'），没有网络，只能读同目录的
// pool-state.js（`globalThis.__OR_POOL__`）。所以每次 quota 刷新后，
// 主进程把当前所有账号的额度快照写一次，面板打开就能看到最新数据。
//
// ⚠ 写文件是「尽力而为」：失败不能影响配额返回（面板只是锦上添花）。

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PROVIDER } from "../context.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))          // <root>/src/hooks
const PANEL_DIR = join(HERE, "..", "..", "panel")             // <root>/panel
export const STATE_FILE = join(PANEL_DIR, "pool-state.js")

/** 写一份占位状态（无数据时），保证面板不会读到上一次的旧数据 */
export async function writePoolState(accounts, at = new Date()) {
  const payload = {
    provider: PROVIDER,
    at: at.toISOString().replace("T", " ").slice(0, 19),
    accounts: Array.isArray(accounts) ? accounts : [],
  }
  const body =
    "// 自动生成，请勿手改 —— 由插件在每次配额刷新后写入\n" +
    `globalThis.__OR_POOL__ = ${JSON.stringify(payload, null, 0)};\n`
  try {
    await mkdir(PANEL_DIR, { recursive: true })
    await writeFile(STATE_FILE, body, "utf8")
    return true
  } catch {
    return false
  }
}

/** 从一份 usage 报告里抽出面板要的字段 */
export function poolEntry(user, report) {
  const fw = (report?.windows || []).find((w) => w && w.name === "free models") || null
  return {
    user: user || report?.user || "?",
    name: report?.user || user || "?",
    remaining: Number(fw?.remaining ?? 0),
    used: Number(fw?.used ?? fw?.amount ?? 0),
    limit: Number(fw?.limit ?? 50),
    resetsAt: fw?.resetsAt || fw?.resets_at || null,
  }
}