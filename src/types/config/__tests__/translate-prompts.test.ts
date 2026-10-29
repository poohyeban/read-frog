import { describe, expect, it } from "vitest"
import { pageCustomPromptsConfigSchema } from "../translate"

const customPrompt = {
  id: "my-custom-prompt",
  name: "My prompt",
  systemPrompt: "Translate carefully.",
  prompt: "{{input}}",
}

describe("built-in translation prompt config", () => {
  it.each(["default", "precision-rewrite"])("accepts page built-in %s", (promptId) => {
    expect(
      pageCustomPromptsConfigSchema.parse({
        promptId,
        patterns: [],
      }),
    ).toEqual({ promptId, patterns: [] })
  })

  it.each([pageCustomPromptsConfigSchema])(
    "normalizes the legacy null selection to default",
    (schema) => {
      expect(schema.parse({ promptId: null, patterns: [] })).toEqual({
        promptId: "default",
        patterns: [],
      })
    },
  )

  it("keeps a legacy null selection on the product default while renaming collisions", () => {
    expect(
      pageCustomPromptsConfigSchema.parse({
        promptId: null,
        patterns: [{ ...customPrompt, id: "precision-rewrite" }],
      }),
    ).toEqual({
      promptId: "default",
      patterns: [{ ...customPrompt, id: "precision-rewrite-custom" }],
    })
  })
})
