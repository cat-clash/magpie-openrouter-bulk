// magpie-openrouter-bulk — OpenRouter 供应商插件（批量 key 账号池）
//
// 这个文件只做**装配**：钩子实现在 src/ 里。改哪一块就去看哪个文件。
//
//   ① config          src/hooks/config.mjs   声明 provider + 静态模型表
//   ② auth.options    src/hooks/options.mjs  GUI 开关（fallbackToHealthy 等）
//   ③ auth.import     src/hooks/import.mjs   批量导入 key（顶层 key + metadata.email）
//   ④ auth.loader     src/hooks/loader.mjs   出站 fetch：prepare + 双维度 429 failover
//   ⑤ auth.usage      src/hooks/usage.mjs    配额窗口（并发闸 3 + 缓存）
//   ⑥ provider.models src/hooks/models.mjs   动态目录 + 静态兜底
//
//   常量/静态表：src/context.mjs。底层实现仍是仓库根目录的 failover / catalog /
//   request / usage 四个模块（保持 import 路径不变）。
//
// ⚠ 入口只导出**两个**符号：OpenRouterPlugin 与 _internal。多导出一个函数，magpie
//   就会把它当成第二个插件。

import { clearUsageCache } from "./usage.mjs"
import {
  classify429,
  DEAD_MODELS,
  fetchWithFailover,
  fmtFailover,
  pickCandidate,
  snapshotStats,
  stats,
} from "./failover.mjs"
import { configHook } from "./src/hooks/config.mjs"
import { importHook, importKeys, parseKeyEntries, parseKeyText } from "./src/hooks/import.mjs"
import { loaderHook } from "./src/hooks/loader.mjs"
import { clearCatalogCache, modelsHook } from "./src/hooks/models.mjs"
import { IMPORT_FROM, IMPORT_FROMS, authOptions } from "./src/hooks/options.mjs"
import { rememberName, usageHook } from "./src/hooks/usage.mjs"
import { HEALTHY_MODELS, PROVIDER } from "./src/context.mjs"
import { createPacer } from "./src/pacing.mjs"

// 节奏闸按插件实例建一份：选项来自 magpie 的 input.magpie.options。
// 默认 requestIntervalMs=0、freeRpmLimit=20（每 key 20/分钟，与平台免费限一致）、
// dailyGuard=true —— 只有「日额度真剩 0」时才会拦下请求，正常路径零延迟。
function pacerFromOptions(options) {
  return createPacer({
    requestIntervalMs: options?.requestIntervalMs,
    freeRpmLimit: options?.freeRpmLimit,
    rpmScope: options?.rpmScope,
    dailyGuard: options?.dailyGuard,
    windowMs: options?.pacingWindowMs,
  })
}

export const OpenRouterPlugin = async ({ client } = {}, options) => {
  const pacer = pacerFromOptions(options)
  return {
    config: configHook(),

    auth: {
      provider: PROVIDER,
      icon: "https://cdn.simpleicons.org/openrouter",
      maxConcurrency: 8,
      methods: [{ type: "api", label: "OpenRouter API key", placeholder: "sk-or-v1-…" }],
      options: authOptions(),
      importFrom: IMPORT_FROM,
      importFroms: IMPORT_FROMS,
      import: importHook(options),
      loader: loaderHook(client, options, pacer),
      usage: usageHook(client, pacer),
    },

    provider: {
      id: PROVIDER,
      models: modelsHook(options),
    },
  }
}

// 供测试与诊断引用（⚠ 入口只放一个插件函数，其余都塞在 _internal 里）
export const _internal = {
  PROVIDER,
  HEALTHY_MODELS,
  rememberName,
  parseKeyText,
  parseKeyEntries,
  importKeys,
  clearCatalogCache,
  clearUsageCache: () => clearUsageCache(),
  createPacer,
  failover: { stats, snapshotStats, fmtFailover, classify429, pickCandidate, DEAD_MODELS, fetchWithFailover },
}
