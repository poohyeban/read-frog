import type { Config } from "@/types/config/config"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isAPIProviderConfig } from "@/types/config/provider"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"

const getItemMock = vi.fn<(...args: any[]) => any>()
const getMetaMock = vi.fn<(...args: any[]) => any>()
const setItemMock = vi.fn<(...args: any[]) => any>()
const setMetaMock = vi.fn<(...args: any[]) => any>()
const runMigrationMock = vi.fn<(...args: any[]) => any>()
const loggerWarnMock = vi.fn<(...args: any[]) => any>()

vi.mock("#imports", () => ({
  storage: {
    getItem: getItemMock,
    getMeta: getMetaMock,
    setItem: setItemMock,
    setMeta: setMetaMock,
  },
}))

vi.mock("wxt/utils/storage", () => ({
  storage: {
    getItem: getItemMock,
    getMeta: getMetaMock,
    setItem: setItemMock,
    setMeta: setMetaMock,
  },
}))

vi.mock("../migration", () => ({
  runMigration: runMigrationMock,
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    warn: loggerWarnMock,
  },
}))

function buildStableConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG)
  // In DEV mode, beta experience is enabled. Keep it true so no extra write is introduced.

  config.providersConfig = config.providersConfig.map((providerConfig) => {
    if (!isAPIProviderConfig(providerConfig)) {
      return providerConfig
    }

    const apiKeyEnvName = `WXT_${providerConfig.provider.toUpperCase()}_API_KEY`
    const envApiKey = import.meta.env[apiKeyEnvName] as string | undefined
    if (!envApiKey) {
      return providerConfig
    }

    return {
      ...providerConfig,
      apiKey: envApiKey,
    }
  })
  return config
}

describe("initializeConfig", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setItemMock.mockResolvedValue(undefined)
    setMetaMock.mockResolvedValue(undefined)
    runMigrationMock.mockImplementation(async (_nextVersion: number, config: Config) => config)
  })

  it.each([
    "https://api.deepseek.com",
    "https://api.deepseek.com/",
    "https://api.deepseek.com/v1",
    "https://api.deepseek.com/v1/",
  ])(
    "upgrades the existing DeepSeek endpoint %s without losing settings or bindings",
    async (baseURL) => {
      const config = buildStableConfig()
      const provider = {
        ...DEFAULT_PROVIDER_CONFIG["openai-compatible"],
        id: config.pageTranslation.providerId,
        name: "My DeepSeek",
        baseURL,
        apiKey: "test-secret",
        headers: { "X-Custom": "test-value" },
        providerOptions: { thinking: { type: "disabled" } },
        temperature: 0.4,
        model: { model: "use-custom-model", isCustomModel: true, customModel: "deepseek-flash" },
      } as const
      config.providersConfig = config.providersConfig.map((item) =>
        item.id === provider.id ? provider : item,
      )
      config.selectionToolbar.builtInActions.dictionary.providerId = provider.id
      config.selectionToolbar.builtInActions.sentenceAnalysis.providerId = provider.id
      getItemMock.mockResolvedValueOnce(config)
      getMetaMock.mockResolvedValueOnce({ schemaVersion: 4, lastModifiedAt: 123 })
      const { initializeConfig } = await import("../init")
      await expect(initializeConfig()).resolves.toEqual({ isFreshInstall: false })
      expect(setItemMock).toHaveBeenCalledOnce()
      const saved = setItemMock.mock.calls[0]![1] as Config
      expect(saved.providersConfig.find((item) => item.id === provider.id)).toEqual({
        ...provider,
        provider: "deepseek",
        model: { ...provider.model, model: "deepseek-flash" },
      })
      expect(saved.pageTranslation).toEqual(config.pageTranslation)
      expect(saved.selectionToolbar.builtInActions).toEqual(config.selectionToolbar.builtInActions)
      expect(saved.selectionToolbar.features).toEqual(config.selectionToolbar.features)
      const { configSchema } = await import("@/types/config/config")
      expect(configSchema.safeParse(saved).success).toBe(true)
      expect(setMetaMock).toHaveBeenCalledWith("local:readFrogLiteConfig", {
        schemaVersion: 5,
        lastModifiedAt: 123,
      })
    },
  )

  it.each([
    "https://api.deepseek.com.evil.example",
    "https://proxy.example/v1",
    "http://api.deepseek.com",
    "https://api.deepseek.com:8443",
    "https://user:password@api.deepseek.com",
    "https://api.deepseek.com/beta",
    "https://api.deepseek.com/?key=test",
    "https://api.deepseek.com/#fragment",
    "not-a-url",
  ])("does not infer a dedicated protocol from %s", async (baseURL) => {
    const config = buildStableConfig()
    config.providersConfig = config.providersConfig.map((provider) =>
      provider.provider === "openai-compatible" ? { ...provider, baseURL } : provider,
    )
    getItemMock.mockResolvedValueOnce(config)
    getMetaMock.mockResolvedValueOnce({ schemaVersion: 4, lastModifiedAt: 123 })
    const { initializeConfig } = await import("../init")
    await initializeConfig()
    const saved = setItemMock.mock.calls[0]![1] as Config
    expect(saved.providersConfig).toEqual(config.providersConfig)
  })

  it("does not write when config and meta are already up to date", async () => {
    const config = buildStableConfig()
    getItemMock.mockResolvedValueOnce(config)
    getMetaMock.mockResolvedValueOnce({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 123,
    })

    const { initializeConfig } = await import("../init")
    await initializeConfig()

    expect(runMigrationMock).not.toHaveBeenCalled()
    expect(setItemMock).not.toHaveBeenCalled()
    expect(setMetaMock).not.toHaveBeenCalled()
  })

  it("does not report a fresh install when a stored config is reused", async () => {
    const config = buildStableConfig()
    getItemMock.mockResolvedValueOnce(config)
    getMetaMock.mockResolvedValueOnce({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 123,
    })

    const { initializeConfig } = await import("../init")
    const { isFreshInstall } = await initializeConfig()

    expect(isFreshInstall).toBe(false)
  })

  it("reports recovery from an unparseable config as a fresh install so the provider probe reruns", async () => {
    getItemMock.mockResolvedValueOnce({ not: "a config" })
    getMetaMock.mockResolvedValueOnce({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 123,
    })

    const { initializeConfig } = await import("../init")
    const { isFreshInstall } = await initializeConfig()

    expect(isFreshInstall).toBe(true)
  })

  it("only updates meta when config is unchanged but lastModifiedAt is missing", async () => {
    const config = buildStableConfig()
    getItemMock.mockResolvedValueOnce(config)
    getMetaMock.mockResolvedValueOnce({
      schemaVersion: CONFIG_SCHEMA_VERSION,
    })

    const { initializeConfig } = await import("../init")
    await initializeConfig()

    expect(setItemMock).not.toHaveBeenCalled()
    expect(setMetaMock).toHaveBeenCalledTimes(1)
    expect(setMetaMock).toHaveBeenCalledWith(
      "local:readFrogLiteConfig",
      expect.objectContaining({
        schemaVersion: CONFIG_SCHEMA_VERSION,
        lastModifiedAt: expect.any(Number),
      }),
    )
  })
})
