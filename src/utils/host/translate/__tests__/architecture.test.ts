import { readFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) =>
  readFile(resolve(import.meta.dirname, "../../../../..", path), "utf8")

describe("translation architecture boundaries", () => {
  it("keeps planning pure and page work independent of background queue ownership", async () => {
    const plan = await source("src/utils/host/translate/translation-plan.ts")
    expect(plan).not.toMatch(
      /getLocalConfig|sendMessage|new RequestQueue|from ["'][^"']*entrypoints\/background/,
    )
    for (const file of ["context-coordinator", "local-scheduler", "translation-session"]) {
      const module = await source(`src/utils/host/translate/${file}.ts`)
      expect(module).not.toMatch(
        /new RequestQueue|new BatchQueue|from ["'][^"']*entrypoints\/background/,
      )
    }
  })
  it("keeps provider execution on transported snapshots and SDK retries disabled", async () => {
    const api = await source("src/utils/host/translate/api/ai.ts")
    expect(api).not.toContain("getModelById")
    expect(api).toMatch(/generateRemoteText\(\s*providerConfig/)
    const gateway = await source("src/utils/providers/remote-executor.ts")
    expect(gateway).toMatch(/maxRetries:\s*0/)
    expect(gateway).toContain("runProviderOperation")
  })
})

it("keeps the runtime dependency graph of the headless engine free of concrete UI", async () => {
  const root = resolve(import.meta.dirname, "../../../../..")
  const visited = new Set<string>()
  async function inspect(file: string): Promise<void> {
    if (visited.has(file)) return
    visited.add(file)
    const text = await readFile(file, "utf8")
    const imports = [
      ...text.matchAll(/(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/g),
    ]
    for (const [, id] of imports) {
      expect(id, `Headless dependency in ${file}`).not.toMatch(
        /^(?:react|react-dom)(?:$|\/)|(?:components|translate\/ui)\/|toast/,
      )
      const base = id!.startsWith("@/")
        ? resolve(root, "src", id!.slice(2))
        : id!.startsWith(".")
          ? resolve(dirname(file), id!)
          : undefined
      if (!base) continue
      let resolved: string | undefined
      for (const path of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        try {
          await readFile(path)
          resolved = path
          break
        } catch {
          /* another extension */
        }
      }
      if (resolved) await inspect(resolved)
    }
  }
  for (const entry of [
    "translation-plan",
    "translation-executor",
    "engine-state",
    "local-scheduler",
    "context-coordinator",
  ]) {
    await inspect(resolve(root, `src/utils/host/translate/${entry}.ts`))
  }
  expect(visited.size).toBeGreaterThan(5)
})
