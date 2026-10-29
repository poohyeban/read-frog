import { describe, expect, it } from "vitest"
import { configSchema } from "@/types/config/config"
import { DEFAULT_CONFIG, buildFreshDefaultConfig } from "@/utils/constants/config"

describe("Lite local provider boundary", () => {
  it("validates a fresh installation without an account", () => {
    expect(configSchema.safeParse(buildFreshDefaultConfig()).success).toBe(true)
    expect(configSchema.safeParse(DEFAULT_CONFIG).success).toBe(true)
  })
})

it("does not resolve an upstream hosted provider", async () => {
  const { resolveProviderRefForCapability } = await import("../provider-registry")
  expect(
    resolveProviderRefForCapability(
      "pageTranslation",
      DEFAULT_CONFIG.providersConfig,
      "read-frog-free-ai",
    ),
  ).toBeNull()
})
