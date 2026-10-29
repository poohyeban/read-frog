import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  findSelectionToolbarAction,
  getBuiltInDictionaryAction,
  getSelectionToolbarActions,
  replaceSelectionToolbarAction,
} from "@/utils/custom-actions"

function cloneSelectionToolbar() {
  return structuredClone(DEFAULT_CONFIG.selectionToolbar)
}

describe("selection toolbar built-in actions", () => {
  it("always resolves the built-in actions before custom actions", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    selectionToolbar.customActions = [
      {
        ...dictionary,
        id: "custom-action",
        name: "Custom",
      },
    ]

    expect(getSelectionToolbarActions(selectionToolbar).map((action) => action.id)).toEqual([
      "default-dictionary",
      "default-sentence-analysis",
      "default-improve-writing",
      "custom-action",
    ])
  })

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

  it("resolves the built-in Improve Writing, on by default, from its stored state", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const action = findSelectionToolbarAction(selectionToolbar, "default-improve-writing")
    expect(action).toMatchObject({
      id: "default-improve-writing",
      enabled: true,
      providerId: DEFAULT_CONFIG.selectionToolbar.builtInActions.improveWriting.providerId,
      icon: "streamline-color:ai-edit-spark-flat",
    })
    expect(action?.outputSchema.map((field) => field.id)).toEqual([
      "default-improve-writing-original",
      "default-improve-writing-setting",
      "default-improve-writing-annotations",
      "default-improve-writing-improved",
      "default-improve-writing-summary",
    ])

    selectionToolbar.builtInActions.improveWriting = {
      enabled: false,
      providerId: "openai-default",
    }
    expect(findSelectionToolbarAction(selectionToolbar, "default-improve-writing")).toMatchObject({
      enabled: false,
      providerId: "openai-default",
    })
  })

  it("reads a built-in action's key from its state, and its default key without one", () => {
    const selectionToolbar = cloneSelectionToolbar()
    selectionToolbar.builtInActions.dictionary.shortcut = ""
    selectionToolbar.builtInActions.sentenceAnalysis.shortcut = "Alt+Shift+K"
    delete selectionToolbar.builtInActions.improveWriting.shortcut

    expect(findSelectionToolbarAction(selectionToolbar, "default-dictionary")?.shortcut).toBe("")
    expect(
      findSelectionToolbarAction(selectionToolbar, "default-sentence-analysis")?.shortcut,
    ).toBe("Alt+Shift+K")
    expect(findSelectionToolbarAction(selectionToolbar, "default-improve-writing")?.shortcut).toBe(
      "Alt+Shift+W",
    )
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
