// src/hooks/options.mjs — auth.options：GUI 里 provider 编辑器上的开关
//
// magpie 把这些渲染成开关，用户改完立刻生效（随 options 进到 loader / models 钩子）。
// 全部默认 false = 语义与 0.4.0 完全一致：不改变你点名的模型，也不隐藏任何模型。

export function authOptions() {
  return [
    {
      key: "fallbackToHealthy",
      label: "死模型自动改投健康模型",
      description:
        "请求点到实测全灭的模型（ling-3.2-flash / gemma-4-*）时，直接改投一个健康的免费模型，省一次必 429 的请求。默认关，避免改变你指定的模型语义。",
      default: false,
      labels: { zh: "死模型自动改投健康模型" },
      descriptions: {
        zh: "请求点到实测全灭的模型（ling-3.2-flash / gemma-4-*）时，直接改投一个健康的免费模型，省一次必 429 的请求。默认关，避免改变你指定的模型语义。",
      },
      placement: "top",
    },
    {
      key: "healthyModelsOnly",
      label: "只显示健康模型",
      description:
        "开启后在模型列表里隐藏实测模型级全灭的 ling-3.2-flash 与 gemma-4-*，只暴露 9 个健康免费模型。",
      default: false,
      labels: { zh: "只显示健康模型" },
      descriptions: {
        zh: "开启后在模型列表里隐藏实测模型级全灭的 ling-3.2-flash 与 gemma-4-*，只暴露 9 个健康免费模型。",
      },
      placement: "top",
    },
    {
      key: "requestIntervalMs",
      label: "同 key 最小请求间隔（毫秒）",
      description:
        "同一把 key 相邻两次请求的最小间隔。默认 0 = 不延迟（与 0.5.0 行为一致）。设成 800 这类值可把突发流量摊平，降低被上游风控的概率。",
      default: 0,
      labels: { zh: "同 key 最小请求间隔（毫秒）" },
      descriptions: {
        zh: "同一把 key 相邻两次请求的最小间隔。默认 0 = 不延迟。设成 800 这类值可把突发流量摊平。",
      },
      placement: "top",
    },
    {
      key: "freeRpmLimit",
      label: "免费模型每分钟请求上限",
      description:
        "OpenRouter 免费模型的平台硬限是 20 请求/分钟。插件用滑动窗口把请求排队在额度内（默认每 key 20）。设 0 关闭窗口。",
      default: 20,
      labels: { zh: "免费模型每分钟请求上限" },
      descriptions: {
        zh: "免费模型每分钟请求上限（默认 20，按 key 各自计算）。插件用滑动窗口把请求排队在额度内；设 0 关闭。",
      },
      placement: "top",
    },
    {
      key: "dailyGuard",
      label: "日额度用尽时直接不发请求",
      description:
        "开启后（默认），若最近一次 /key 快照显示 free_model_daily_requests 剩余 0，请求直接短路成 key 级 429，交给 magpie 换账号，省掉一次必然失败的上游请求。",
      default: true,
      labels: { zh: "日额度用尽时直接不发请求" },
      descriptions: {
        zh: "开启后（默认），若最近一次 /key 快照显示免费日额度剩余 0，请求直接短路，交给 magpie 换账号。",
      },
      placement: "top",
    },
  ]
}

export const IMPORT_FROM = {
  en: "OpenRouter keys.txt (one key per line, # comments)",
  zh: "OpenRouter keys.txt（每行一个 Key，# 注释）",
}

export const IMPORT_FROMS = {
  en: "OpenRouter keys.txt (one key per line)",
  zh: "OpenRouter keys.txt（每行一个 Key）",
}
