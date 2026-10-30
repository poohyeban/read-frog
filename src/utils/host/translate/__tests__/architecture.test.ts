import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
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
    expect(api).toContain("getLanguageModelForConfig(providerConfig)")
    expect(api).toMatch(/maxRetries:\s*0/)
  })
})
