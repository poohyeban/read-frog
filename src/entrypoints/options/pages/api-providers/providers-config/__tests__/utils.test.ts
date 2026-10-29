import type { Config } from "@/types/config/config"
import { describe, expect, it, vi } from "vitest"
import { initI18n } from "@/utils/i18n"
import { addProvider } from "../utils"

describe("api provider utils", () => {
  it("adds the OpenAI-compatible provider with its localized default description", async () => {
    await initI18n("en")
    let updatedProviders: Config["providersConfig"] | undefined
    const setProvidersConfig = vi.fn<(...args: any[]) => any>(async (config) => {
      updatedProviders = config as Config["providersConfig"]
    })

    await addProvider("openai-compatible", [], setProvidersConfig)

    expect(updatedProviders?.[0]).toEqual(
      expect.objectContaining({
        provider: "openai-compatible",
        name: "options.apiProviders.providers.name.customChatComplete",
        description: "options.apiProviders.providers.description.openaiCompatible",
      }),
    )
  })
})
