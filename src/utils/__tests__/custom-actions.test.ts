import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  findSelectionToolbarAction,
  getBuiltInDictionaryAction,
  replaceSelectionToolbarAction,
} from "@/utils/custom-actions"

function cloneSelectionToolbar() {
  return structuredClone(DEFAULT_CONFIG.selectionToolbar)
}

describe("selection toolbar built-in actions", () => {
  it("resolves the built-in Sentence Analysis from its stored state", () => {
    const selectionToolbar = cloneSelectionToolbar()
    selectionToolbar.builtInActions.sentenceAnalysis = {
      enabled: false,
      providerId: "openai-default",
    }

    const action = findSelectionToolbarAction(selectionToolbar, "default-sentence-analysis")
    expect(action).toMatchObject({
      id: "default-sentence-analysis",
      enabled: false,
      providerId: "openai-default",
      icon: "streamline-color:search-visual-flat",
    })
    expect(action?.outputSchema.map((field) => field.id)).toEqual([
      "default-sentence-analysis-sentence",
      "default-sentence-analysis-annotations",
      "default-sentence-analysis-translation",
    ])
    expect(action?.outputSchema[0]?.source).toBe("selection")
  })

  it("writes back a state without a key without one, until the key changes", () => {
    const selectionToolbar = cloneSelectionToolbar()
    delete selectionToolbar.builtInActions.dictionary.shortcut
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    expect(dictionary.shortcut).toBe("Alt+Shift+D")

    const providerChanged = replaceSelectionToolbarAction(selectionToolbar, {
      ...dictionary,
      providerId: "openai-default",
    })
    expect(providerChanged.builtInActions.dictionary).not.toHaveProperty("shortcut")

    const keyChanged = replaceSelectionToolbarAction(selectionToolbar, {
      ...dictionary,
      shortcut: "Alt+Shift+K",
    })
    expect(keyChanged.builtInActions.dictionary.shortcut).toBe("Alt+Shift+K")
  })
})
