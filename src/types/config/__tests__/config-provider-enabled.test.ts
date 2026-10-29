import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { configSchema } from "../config"

function getIssuePaths(input: unknown) {
  const result = configSchema.safeParse(input)
  if (result.success) {
    return []
  }

  return result.error.issues.map((issue) => issue.path.join("."))
}

describe("config provider enabled validation", () => {
  it("fails when the built-in Dictionary uses a disabled provider", () => {
    const providersConfig = DEFAULT_CONFIG.providersConfig.map((provider) =>
      provider.id === "openai-default" ? { ...provider, enabled: false } : provider,
    )
    const issuePaths = getIssuePaths({
      ...DEFAULT_CONFIG,
      providersConfig,
      selectionToolbar: {
        ...DEFAULT_CONFIG.selectionToolbar,
        builtInActions: {
          dictionary: {
            ...DEFAULT_CONFIG.selectionToolbar.builtInActions.dictionary,
            providerId: "openai-default",
          },
        },
      },
    })

    expect(issuePaths).toContain("selectionToolbar.builtInActions.dictionary.providerId")
  })

  it("rejects an unknown provider for selection toolbar translation", () => {
    const issuePaths = getIssuePaths({
      ...DEFAULT_CONFIG,
      selectionToolbar: {
        ...DEFAULT_CONFIG.selectionToolbar,
        features: {
          ...DEFAULT_CONFIG.selectionToolbar.features,
          translate: {
            ...DEFAULT_CONFIG.selectionToolbar.features.translate,
            providerId: "nonexistent-provider",
          },
        },
      },
    })

    expect(issuePaths).toContain("selectionToolbar.features.translate.providerId")
  })
})
