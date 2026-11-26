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
