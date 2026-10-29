import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { initializeConfig } from "../init"
import { getLocalConfig, setLocalConfig } from "../storage"

describe("Lite local configuration", () => {
  beforeEach(async () => {
    await browser.storage.local.clear()
    vi.stubGlobal("fetch", vi.fn<typeof fetch>())
  })
  afterEach(() => vi.unstubAllGlobals())

  it("initializes without an account and preserves credentials across a module reload", async () => {
    const syncWrite = vi.spyOn(browser.storage.sync, "set")
    await initializeConfig()
    const config = await getLocalConfig()
    expect(config).not.toBeNull()
    if (!config) throw new Error("Missing default config")
    expect(config.pageTranslation.page.autoTranslatePatterns).toEqual([])
    expect(config.pageTranslation.page.autoTranslateLanguages).toEqual([])
    config.language.targetCode = "jpn"
    config.providersConfig[0]!.apiKey = "local-test-credential"
    await setLocalConfig(config)

    vi.resetModules()
    const reloaded = await import("../storage")
    const persisted = await reloaded.getLocalConfig()
    expect(persisted?.language.targetCode).toBe("jpn")
    expect(persisted?.providersConfig[0]?.apiKey).toBe("local-test-credential")
    expect(await storage.getItem(`local:${CONFIG_STORAGE_KEY}`)).toEqual(persisted)
    expect(syncWrite).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    syncWrite.mockRestore()
  })

  it("rejects a removed hosted provider instead of granting a synthetic entitlement", async () => {
    await initializeConfig()
    const config = await getLocalConfig()
    if (!config) throw new Error("Missing default config")
    config.pageTranslation.providerId = "read-frog-free-ai"
    expect(configSchema.safeParse(config).success).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
