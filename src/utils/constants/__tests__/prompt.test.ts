import { describe, expect, it } from "vitest"
import { PRECISION_REWRITE_TRANSLATE_SYSTEM_PROMPT } from "../prompt"

describe("built-in translation prompts", () => {
  it("keeps precision self-review silent and final-output-only", () => {
    expect(PRECISION_REWRITE_TRANSLATE_SYSTEM_PROMPT).toContain(
      "Perform these steps internally without revealing them",
    )
    expect(PRECISION_REWRITE_TRANSLATE_SYSTEM_PROMPT).toContain(
      "Never output analysis, reasoning, drafts, diagnoses, issue lists, or commentary",
    )
    expect(PRECISION_REWRITE_TRANSLATE_SYSTEM_PROMPT).not.toContain("List all issues")
    expect(PRECISION_REWRITE_TRANSLATE_SYSTEM_PROMPT).not.toContain("brief clarification")
  })
})
