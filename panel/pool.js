// OpenRouter 账号池面板（magpie.panels, slot: provider）
//
// 一行概览 + 一个「一键刷新」按钮 + 可折叠详情。
// 刷新走 magpie 自己的网关端点（同源，无需额外权限）：
//   GET  /v1/magpie/quotas            —— 读所有 provider 的额度快照
//   POST /v1/magpie/quotas/refresh    —— 触发重新探测
// 目标 provider id 从面板 URL 的 ?provider= 或固定常量取。

(async () => {
  const PROVIDER = "openrouter-live"
  const PROVIDER_LABEL = "OpenRouter"

  const $ = (id) => document.getElementById(id)
  const summary = $("summary")
  const status = $("status")
  const grid = $("grid")
  const note = $("note")
  const btn = $("refresh")

  const STRINGS = {
    zh: {
      label: "账号池",
      details: "详情",
      refresh: "一键刷新",
      refreshing: "刷新中…",
      done: "已刷新",
      readFail: "读取失败：",
      refreshFail: "刷新失败：",
      noData: "暂无数据 — 点「一键刷新」探测",
      note: "只统计免费模型的每日请求额度；每账号 50 次/天，UTC 0 点重置。",
      accounts: "账号",
      withQuota: "有额度",
      exhausted: "已用尽",
      remaining: "剩余请求",
    },
    en: {
      label: "Account pool",
      details: "Details",
      refresh: "Refresh all",
      refreshing: "Refreshing…",
      done: "Refreshed",
      readFail: "Could not read: ",
      refreshFail: "Refresh failed: ",
      noData: "No data yet — press Refresh all",
      note: "Free-model daily requests only; 50 per account per day, resets at 00:00 UTC.",
      accounts: "accounts",
      withQuota: "with quota",
      exhausted: "exhausted",
      remaining: "requests left",
    },
  }

  await magpie.ready
  const lang = String(magpie.theme?.lang || document.documentElement.lang || "en").toLowerCase()
  const t = STRINGS[lang.startsWith("zh") ? "zh" : "en"]
  $("label").textContent = t.label
  $("details-summary").textContent = t.details
  btn.textContent = t.refresh
  note.textContent = t.note

  /** 从 quota 快照里挑出本 provider 的账号 */
  const pickAccounts = (payload) => {
    const rows = []
    const walk = (o) => {
      if (!o || typeof o !== "object") return
      if (Array.isArray(o)) { o.forEach(walk); return }
      // 一个账号的额度卡：有 provider 且 provider 匹配
      if (o.provider === PROVIDER && Array.isArray(o.windows)) {
        rows.push(o)
        return
      }
      // magpie 的 map 形状：{ "provider/user": { quota: {...} } }
      if (o.quota && o.quota.provider === PROVIDER) {
        rows.push(o.quota)
        return
      }
      for (const v of Object.values(o)) walk(v)
    }
    walk(payload)
    return rows
  }

  const freeWindow = (acct) =>
    (acct.windows || []).find((w) => w && w.name === "free models") || null

  const paint = (accts) => {
    if (!accts.length) {
      summary.textContent = t.noData
      grid.innerHTML = ""
      return
    }
    let withQuota = 0, exhausted = 0, left = 0
    const cards = []
    for (const a of accts) {
      const fw = freeWindow(a)
      if (!fw) continue
      const rem = Number(fw.remaining ?? 0)
      const used = Number(fw.used ?? fw.amount ?? 0)
      const limit = Number(fw.limit ?? 50)
      if (rem > 0) { withQuota++; left += rem } else exhausted++
      cards.push({ user: a.user || a.name || "?", rem, used, limit, resetsAt: fw.resetsAt || fw.resets_at })
    }
    cards.sort((x, y) => y.rem - x.rem)

    summary.textContent =
      `${accts.length} ${t.accounts} · ${withQuota} ${t.withQuota} · ` +
      `${exhausted} ${t.exhausted} · ${left} ${t.remaining}`

    grid.innerHTML = ""
    for (const c of cards.slice(0, 60)) {
      const el = document.createElement("div")
      el.className = "pool-card " + (c.rem > 0 ? "ok" : "spent")
      const name = document.createElement("div")
      name.className = "pool-card-name"
      name.textContent = c.user
      name.title = c.user
      const bar = document.createElement("div")
      bar.className = "pool-bar"
      const fill = document.createElement("i")
      fill.style.width = Math.max(0, Math.min(100, (c.rem / (c.limit || 50)) * 100)) + "%"
      bar.appendChild(fill)
      const meta = document.createElement("div")
      meta.className = "pool-card-meta"
      meta.textContent = `${c.used} / ${c.limit} · ${c.rem > 0 ? c.rem + " left" : "0 left"}`
      el.append(name, bar, meta)
      grid.appendChild(el)
    }
  }

  const readQuotas = async () => {
    const r = await fetch("/v1/magpie/quotas?kept=1", {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }

  const load = async () => {
    try {
      const payload = await readQuotas()
      paint(pickAccounts(payload))
    } catch (err) {
      summary.textContent = t.readFail + (err?.message || err)
    }
  }

  await load()

  btn.addEventListener("click", async () => {
    btn.disabled = true
    const before = btn.textContent
    btn.textContent = t.refreshing
    status.textContent = ""
    try {
      const r = await fetch(`/v1/magpie/quotas/refresh?provider=${encodeURIComponent(PROVIDER)}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await load()
      status.textContent = t.done
    } catch (err) {
      status.textContent = t.refreshFail + (err?.message || err)
    } finally {
      btn.disabled = false
      btn.textContent = before
    }
  })
})()
