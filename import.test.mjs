import assert from "node:assert"
import { _internal } from "./index.mjs"

const { parseKeyText, importKeys } = _internal

// ---- parseKeyText：纯文本 ----
const text = [
  "# comment line",
  "sk-or-v1-aaaa1111bbbb2222cccc3333",
  "",
  "sk-or-v1-dddd4444eeee5555ffff6666  sk-or-v1-aaaa1111bbbb2222cccc3333", // 同行两个 + 重复
  "garbage not-a-key",
  "sk-or-v1-gggg7777hhhh8888",
].join("\n")
const keys = parseKeyText(text)
assert.deepEqual(keys, [
  "sk-or-v1-aaaa1111bbbb2222cccc3333",
  "sk-or-v1-dddd4444eeee5555ffff6666",
  "sk-or-v1-gggg7777hhhh8888",
], "plain text parse")
console.log("PASS: parseKeyText plain text (comments/blank/dupes/tokens)")

// ---- parseKeyText：api_keys.json（registrar 导出格式）----
const json = JSON.stringify({
  provider: "openrouter",
  count: 2,
  keys: [
    { key: "sk-or-v1-zzzz0000yyyy1111", email: "u1@example.com" },
    { key: "sk-or-v1-zzzz0000yyyy1111", email: "dupe" },
    { key: "not-or-key", email: "bad" },
    { key: "sk-or-v1-xxxx2222wwww3333", email: "u2@example.com" },
  ],
})
assert.deepEqual(parseKeyText(json), [
  "sk-or-v1-zzzz0000yyyy1111",
  "sk-or-v1-xxxx2222wwww3333",
], "json parse")
console.log("PASS: parseKeyText api_keys.json format (dedupe/bad filtered)")

// ---- parseKeyText：坏 JSON 回退按行 ----
const broken = "{broken json\nsk-or-v1-vvvv9999uuuu8888"
assert.deepEqual(parseKeyText(broken), ["sk-or-v1-vvvv9999uuuu8888"], "broken json fallback")
console.log("PASS: parseKeyText broken-JSON fallback")

// ---- importKeys：verify=false（不联网）----
const res = await importKeys([
  "sk-or-v1-qwer1234qwer1234qwer1234",
  "sk-or-v1-asdf5678asdf5678asdf5678",
], { verify: false })
assert.equal(res.filter((r) => r.type === "success").length, 2, "importKeys offline")
assert.ok(res.every((r) => r.accountId.startsWith("key-")), "accountId short id")
console.log("PASS: importKeys offline (verify=false) + accountId shape")

// ---- importKeys：失败路径（mock fetch 401）----
const origFetch = globalThis.fetch
globalThis.fetch = async () => ({ status: 401, ok: false })
const res2 = await importKeys(["sk-or-v1-fail0000fail0000fail0000"], {})
globalThis.fetch = origFetch
assert.equal(res2[0].type, "failed", "401 -> failed")
assert.match(res2[0].error, /rejected/, "error message mentions rejection")
console.log("PASS: importKeys 401 -> failed entry")

// ---- importKeys：signal abort ----
const ctrl = new AbortController()
ctrl.abort()
const res3 = await importKeys(["sk-or-v1-abrt9999abrt9999abrt9999"], { signal: ctrl.signal, verify: false })
assert.equal(res3.length, 0, "aborted before processing")
console.log("PASS: importKeys signal abort")

// ---- >100 截断在 auth.import 调用方，parseKeyText 无截断 ----
const many = parseKeyText(Array.from({ length: 150 }, (_, i) => `sk-or-v1-bulk${i}bulk${i}bulk${i}`).join("\n"))
assert.equal(many.length, 150, "no truncation in parser")
console.log("PASS: parseKeyText no internal truncation (import hook slices to 100)")

// ---- auth.import result must satisfy magpie's keptAs() (regression) ----
// magpie reads a TOP-LEVEL `key`; `{auth:{key}}` made every entry
// "gave nothing to keep" and the CLI reported "nothing imported".
const { OpenRouterPlugin: Plugin } = await import("./index.mjs")
const hooks = await Plugin({}, { verifyImport: false })
const imported = await hooks.auth.import([
  JSON.stringify({ keys: [{ key: "sk-or-v1-doctoraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111", email: "doctor@example.test" }] }),
])
assert.equal(imported.length, 1, "one success entry")
const r = imported[0]
assert.equal(r.type, "success")
assert.equal(r.key, "sk-or-v1-doctoraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111", "top-level key for magpie keptAs()")
assert.equal(r.provider, "openrouter-live", "provider on the result")
assert.equal(r.metadata.email, "doctor@example.test", "email preserved for settle() dedupe")
assert.ok(!("auth" in r), "no nested auth object")
// verbatim copy of magpie's keptAs()
const keptAs = (x) => ("refresh" in x || "key" in x) ? x : (typeof x.access === "string" && x.access ? { ...x, refresh: "" } : null)
assert.ok(keptAs(r), "magpie keptAs() accepts this result")
console.log("PASS: auth.import result matches magpie keptAs() contract + keeps email")

console.log("\nALL TESTS PASSED")
