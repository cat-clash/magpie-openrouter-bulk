// OpenRouter 账号池面板（magpie.panels, slot: provider）
//
// ⚠ 面板跑在 sandbox 里（connect-src 'none'），**没有网络**：
//   · 不能 fetch —— 数据只能来自插件主进程写好的 pool-state.js
//   · 不能顶层 await —— 这是经典脚本，包一层 async IIFE
//   · 只能读写本插件选项：magpie.options.get() / .set()
//
// options.set 是**整份替换**（一秒最多一次）：每次都要把读到的 opts 展开再写回。

void (async () => {
  await magpie.ready

  const root = document.getElementById("root")
  const data = globalThis.__OR_POOL__

  const el = (tag, cls, text) => {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = text
    return node
  }

  const STRINGS = {
    zh: {
      noData: "还没有账号池数据。在 magpie 里用 OpenRouter 发一次请求，或跑一次 quota 刷新，这里就会出现。",
      accounts: "账号",
      withQuota: "有额度",
      exhausted: "已用尽",
      left: "剩余请求",
      options: "Failover 选项",
      fallback: "死模型自动改投健康模型",
      healthyOnly: "只列健康模型",
      freeOnly: "只列免费模型",
      interval: "每 key 最小间隔 (ms)",
      rpm: "免费模型每分钟上限",
      dailyGuard: "日额度耗尽时短路",
      save: "保存",
      saved: "已保存 · 下个请求起生效",
      saveFail: "保存失败：",
      readFail: "读取选项失败：",
    },
    en: {
      noData: "No pool data yet. Send one OpenRouter request in magpie, or refresh quotas, and it shows up here.",
      accounts: "accounts",
      withQuota: "with quota",
      exhausted: "exhausted",
      left: "requests left",
      options: "Failover options",
      fallback: "Switch dead models to a healthy one",
      healthyOnly: "List healthy models only",
      freeOnly: "List free models only",
      interval: "Min interval per key (ms)",
      rpm: "Free-model requests per minute",
      dailyGuard: "Short-circuit when daily quota is spent",
      save: "Save",
      saved: "Saved · applies to the next request",
      saveFail: "Could not save: ",
      readFail: "Could not read options: ",
    },
  }

  const lang = String(magpie.theme?.lang || document.documentElement.lang || "en").toLowerCase()
  const t = STRINGS[lang.startsWith("zh") ? "zh" : "en"]

  // ---------- 渲染账号池 ----------
  if (!data || !Array.isArray(data.accounts) || !data.accounts.length) {
    root.replaceChildren(el("p", "muted", t.noData))
  } else {
    const accts = data.accounts
    let withQuota = 0, exhausted = 0, left = 0
    for (const a of accts) {
      if ((a.remaining ?? 0) > 0) { withQuota++; left += a.remaining } else exhausted++
    }

    const head = el("div", "head")
    head.append(
      el("div", "big", `${accts.length} ${t.accounts}`),
      el("div", "sub", `${withQuota} ${t.withQuota} · ${exhausted} ${t.exhausted} · ${left} ${t.left}`),
    )
    if (data.at) head.append(el("div", "sub muted", data.at))
    root.replaceChildren(head)

    const grid = el("div", "grid")
    const sorted = [...accts].sort((x, y) => (y.remaining ?? 0) - (x.remaining ?? 0))
    for (const a of sorted.slice(0, 80)) {
      const card = el("div", "card " + ((a.remaining ?? 0) > 0 ? "ok" : "spent"))
      card.append(el("div", "name", a.name || a.user || "?"))
      const bar = el("div", "bar")
      const limit = a.limit || 50
      const fill = el("i")
      fill.style.width = Math.max(0, Math.min(100, ((a.remaining ?? 0) / limit) * 100)) + "%"
      bar.append(fill)
      card.append(bar)
      card.append(el("div", "meta", `${a.used ?? 0} / ${limit} · ${a.remaining ?? 0} left`))
      grid.append(card)
    }
    root.append(grid)
  }

  // ---------- 选项编辑 ----------
  let opts = {}
  try {
    const got = await magpie.options.get()
    if (got && typeof got === "object" && !Array.isArray(got)) opts = got
  } catch (err) {
    root.append(el("p", "hint", t.readFail + (err?.message || err)))
  }

  const box = el("div", "opts")
  box.append(el("div", "opts-title", t.options))

  const num = (label, key, def) => {
    const row = el("label", "opt")
    row.append(el("span", "opt-label", label))
    const input = el("input")
    input.type = "number"
    input.min = "0"
    input.value = String(opts[key] ?? def)
    row.append(input)
    box.append(row)
    return { key, input }
  }
  const bool = (label, key, def) => {
    const row = el("label", "opt")
    row.append(el("span", "opt-label", label))
    const input = el("input")
    input.type = "checkbox"
    input.checked = opts[key] ?? def
    row.append(input)
    box.append(row)
    return { key, input, isBool: true }
  }

  const fields = [
    bool(t.fallback, "fallbackToHealthy", false),
    bool(t.healthyOnly, "healthyModelsOnly", false),
    bool(t.freeOnly, "freeOnly", false),
    num(t.interval, "requestIntervalMs", 0),
    num(t.rpm, "freeRpmLimit", 20),
    bool(t.dailyGuard, "dailyGuard", true),
  ]

  const saveBtn = el("button", "btn", t.save)
  saveBtn.type = "button"
  const status = el("span", "muted")
  box.append(saveBtn, status)
  root.append(box)

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true
    try {
      const next = { ...opts }
      for (const f of fields) {
        if (f.isBool) next[f.key] = !!f.input.checked
        else {
          const n = Number(f.input.value)
          next[f.key] = Number.isFinite(n) && n >= 0 ? n : 0
        }
      }
      const back = await magpie.options.set(next)
      if (back && typeof back === "object" && !Array.isArray(back)) opts = back
      status.textContent = t.saved
    } catch (err) {
      status.textContent = t.saveFail + (err?.message || err)
    } finally {
      saveBtn.disabled = false
    }
  })
})()