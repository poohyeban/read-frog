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
          if (module === "ai")
            for (const item of node.specifiers) {
              if (item.type === "ImportNamespaceSpecifier") expect(name).toBe(gateway)
              if (item.type === "ImportSpecifier" && item.importKind !== "type") {
                const imported =
                  item.imported.type === "Identifier" ? item.imported.name : item.imported.value
                if (
                  /^(?:generateText|streamText|generateObject|streamObject|(?:experimental_)?generateSpeech|(?:experimental_)?transcribe)$/.test(
                    imported,
                  )
                )
                  expect(name, `SDK bypass in ${name}`).toBe(gateway)
              }
            }
          if (/^(?:@ai-sdk\/|ai-sdk-ollama)/.test(module))
            expect(adapters.has(name), `Adapter outside transport boundary: ${name}`).toBe(true)
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
