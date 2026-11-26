// src/hooks/config.mjs — config 钩子：声明 provider 与静态模型表
//
// 三态降级里的第一态：静态表必须有内容 —— 未登录也要能显示模型，否则 GUI 显示 "0 models"。
// 用户已经在 cfg.provider[PROVIDER] 里配过的东西一律不动（??= 而非 =）。

import { BASE, FREE_MODELS, PROVIDER } from "../context.mjs"

export function configHook() {
  return async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "OpenRouter",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
      // 分类器请求会带 POST {baseURL}/systemone 进 loader.fetch，
      // 由 request.mjs 改写到 Decisions API。
      decide: true,
      models: { ...FREE_MODELS },
    }
  }
}
