import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  duplicateSelectionToolbarAction,
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
    expect(action?.layout).toContain("default-sentence-analysis-annotations")
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
    expect(action?.layout).toContain("default-improve-writing-annotations")

    selectionToolbar.builtInActions.improveWriting = {
      enabled: false,
      providerId: "openai-default",
    }
    expect(findSelectionToolbarAction(selectionToolbar, "default-improve-writing")).toMatchObject({
      enabled: false,
      providerId: "openai-default",
    })
  })

  it("never persists the built-in Dictionary's layout", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    expect(dictionary.layout).toEqual(expect.any(String))

    const next = replaceSelectionToolbarAction(selectionToolbar, {
      ...dictionary,
      layout: "<p>Attempted layout edit</p>",
    })

    expect(next.builtInActions.dictionary).not.toHaveProperty("layout")
    expect(getBuiltInDictionaryAction(next).layout).toBe(dictionary.layout)
    expect(next.customActions).toEqual([])
  })

  it("stores a custom action's layout as given", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const custom = {
      ...getBuiltInDictionaryAction(selectionToolbar),
      id: "custom-action",
      name: "Custom",
      layout: "<p>{{ Before }}</p>",
    }
    selectionToolbar.customActions = [custom]

    const next = replaceSelectionToolbarAction(selectionToolbar, {
      ...custom,
      layout: "<p>{{ After }}</p>",
    })

    expect(next.customActions[0]?.layout).toBe("<p>{{ After }}</p>")
  })

  it("copies the layout when duplicating", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    const custom = { ...dictionary, id: "custom-action", name: "Custom", layout: "<p>mine</p>" }

    expect(duplicateSelectionToolbarAction(dictionary, [dictionary]).layout).toBe(dictionary.layout)
    expect(duplicateSelectionToolbarAction(custom, [dictionary, custom]).layout).toBe("<p>mine</p>")
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

describe("subtitle word lookup action", () => {})
