import { readFile, readdir } from "node:fs/promises"
import { resolve, relative } from "node:path"
import { parseSync, Visitor } from "vite"
import { describe, expect, it } from "vitest"
const root = resolve(import.meta.dirname, "../../../..")
async function files(dir: string): Promise<string[]> {
  const all = await readdir(dir, { withFileTypes: true })
  return (
    await Promise.all(
      all
        .filter((e) => e.name !== "__tests__")
        .map(async (e) =>
          e.isDirectory()
            ? files(resolve(dir, e.name))
            : /\.tsx?$/.test(e.name)
              ? [resolve(dir, e.name)]
              : [],
        ),
    )
  ).flat()
}
const gateway = "src/utils/providers/remote-executor.ts"
const adapters = new Set([
  "src/utils/providers/model.ts",
  "src/utils/providers/audio/openai-audio.ts",
])
const localFetch = new Set([
  ...adapters,
  // Fetches the unprocessed subtitle track, never model inference.
  "src/utils/subtitles/fetchers/youtube/index.ts",
  // Explicit model discovery; no inference or user content is sent.
  "src/entrypoints/options/pages/api-providers/providers-config/provider-config-form/components/model-suggestion-button.tsx",
])
describe("executable remote entrypoint coverage", () => {
  it("requires every inference SDK and transport entrypoint to use the shared authority", async () => {
    for (const file of await files(resolve(root, "src"))) {
      const name = relative(root, file),
        text = await readFile(file, "utf8")
      const parsed = parseSync(file, text)
      expect(parsed.errors).toHaveLength(0)
      new Visitor({
        ImportDeclaration(node) {
          const module = node.source.value
          if (node.importKind === "type") return
          if (module === "ai") {
            // Allow only audited local helpers outside the gateway. New SDK inference
            // APIs (including embeddings/images) must not silently escape a name blacklist.
            const localHelpers = new Set(["Output", "parsePartialJson"])
            for (const item of node.specifiers) {
              if (item.type === "ImportSpecifier" && item.importKind === "type") continue
              const imported =
                item.type === "ImportSpecifier"
                  ? item.imported.type === "Identifier"
                    ? item.imported.name
                    : item.imported.value
                  : "*"
              if (!localHelpers.has(imported)) expect(name, `SDK bypass in ${name}`).toBe(gateway)
            }
          }
          if (/^(?:@ai-sdk\/|ai-sdk-ollama)/.test(module))
            expect(adapters.has(name), `Adapter outside transport boundary: ${name}`).toBe(true)
          if (module.endsWith("/resource-scheduler") || module === "./resource-scheduler")
            if (
              node.specifiers.some(
                (item) => item.type === "ImportSpecifier" && item.importKind !== "type",
              )
            )
              expect(name, "Only the background runtime constructs physical authority").toBe(
                "src/utils/providers/resource-runtime.ts",
              )
          if (/^(?:axios|ky|got|node-fetch|undici)$/.test(module))
            expect(adapters.has(name), `Unreviewed transport library: ${name}`).toBe(true)
        },
        ImportExpression(node) {
          if (
            node.source.type === "Literal" &&
            typeof node.source.value === "string" &&
            /^(?:ai$|@ai-sdk\/|ai-sdk-ollama)/.test(node.source.value)
          )
            expect(
              name === gateway || adapters.has(name),
              `Dynamic inference SDK bypass: ${name}`,
            ).toBe(true)
        },
        MemberExpression(node) {
          const property =
            node.computed && node.property.type === "Literal"
              ? node.property.value
              : node.property.type === "Identifier"
                ? node.property.name
                : undefined
          if (property === "doGenerate" || property === "doStream")
            expect(adapters.has(name), `Aliased SDK method bypass: ${name}`).toBe(true)
          if (
            property === "fetch" &&
            node.object.type === "Identifier" &&
            ["globalThis", "window"].includes(node.object.name)
          )
            expect(localFetch.has(name), `Aliased network entrypoint: ${name}`).toBe(true)
        },
        CallExpression(node) {
          const expression = text.slice(node.callee.start, node.callee.end)
          if (/^(?:(?:globalThis|window)\.)?fetch$/.test(expression))
            expect(localFetch.has(name), `Unreviewed network entrypoint: ${name}`).toBe(true)
          if (/\.(?:doGenerate|doStream)$/.test(expression))
            expect(adapters.has(name), `Direct SDK method bypass: ${name}`).toBe(true)
          if (expression === "getLanguageModelForConfig")
            expect(name === gateway || adapters.has(name), `Model bypass: ${name}`).toBe(true)
        },
        NewExpression(node) {
          if (
            node.callee.type === "Identifier" &&
            ["XMLHttpRequest", "WebSocket", "EventSource"].includes(node.callee.name)
          )
            expect(localFetch.has(name), `Unreviewed remote transport: ${name}`).toBe(true)
          if (text.slice(node.callee.start, node.callee.end) === "ResourceScheduler")
            expect(name).toBe("src/utils/providers/resource-runtime.ts")
        },
      }).visit(parsed.program)
    }

    const playback = await readFile(
      resolve(root, "src/entrypoints/background/tts-playback.ts"),
      "utf8",
    )
    expect(playback).not.toMatch(/runProviderOperation|ResourceScheduler|generateRemoteText/)
    const text = await readFile(resolve(root, gateway), "utf8")
    expect(text.match(/maxRetries:\s*0/g)).toHaveLength(2)
    expect(text).toContain("await consume(")
  })
})
