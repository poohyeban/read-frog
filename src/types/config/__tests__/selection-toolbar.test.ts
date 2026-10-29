import { describe, expect, it } from "vitest"
import { selectionToolbarCustomActionsSchema } from "../selection-toolbar"

const customAction = {
  id: "custom-action",
  name: "Custom Action",
  enabled: true,
  icon: "tabler:sparkles",
  providerId: "read-frog-free-ai",
  systemPrompt: "",
  prompt: "{{selection}}",
  outputSchema: [
    {
      id: "result",
      name: "Result",
      type: "string" as const,
      description: "",
    },
  ],
}

describe("selectionToolbarCustomActionsSchema", () => {
  it.each(["default-dictionary", "default-sentence-analysis"])(
    "rejects the built-in id %s in custom actions",
    (id) => {
      const result = selectionToolbarCustomActionsSchema.safeParse([{ ...customAction, id }])

      expect(result.success).toBe(false)
      if (result.success) {
        throw new Error("Expected the reserved action id to be rejected")
      }

      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          message: `Action id "${id}" is reserved for a built-in action.`,
          path: [0, "id"],
        }),
      )
    },
  )

  it("accepts ordinary custom action ids", () => {
    expect(selectionToolbarCustomActionsSchema.safeParse([customAction]).success).toBe(true)
  })
})
