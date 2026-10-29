import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"
import {
  getSelectionToolbarItems,
  reorderSelectionToolbarItems,
  setSelectionToolbarCustomActions,
  setSelectionToolbarItemPinned,
} from "@/utils/selection-toolbar-items"

function toolbarWith(customIds: string[] = [], order?: string[]) {
  const selectionToolbar = structuredClone(DEFAULT_CONFIG.selectionToolbar)
  const dictionary = getBuiltInDictionaryAction(selectionToolbar)
  selectionToolbar.customActions = customIds.map((id): SelectionToolbarCustomAction => ({
    ...dictionary,
    id,
    name: id,
  }))
  if (order) selectionToolbar.order = order
  return selectionToolbar
}

const idsOf = (selectionToolbar: ReturnType<typeof toolbarWith>) =>
  getSelectionToolbarItems(selectionToolbar).map((item) => item.id)

describe("getSelectionToolbarItems", () => {
  it("lists the features, built-in actions and custom actions in the default order", () => {
    expect(idsOf(toolbarWith(["a", "b"]))).toEqual([
      "translate",

      "default-dictionary",
      "default-sentence-analysis",
      "default-improve-writing",
      "a",
      "b",
    ])
  })

  it("follows the saved order across features and actions", () => {
    const selectionToolbar = toolbarWith(
      ["a", "b"],
      ["b", "default-sentence-analysis", "translate", "a", "default-dictionary"],
    )
    expect(idsOf(selectionToolbar)).toEqual([
      "b",

      "default-sentence-analysis",
      "translate",
      "a",
      "default-dictionary",
      "default-improve-writing",
    ])
  })

  it("puts items the order does not name after it, and skips ids no item has", () => {
    const selectionToolbar = toolbarWith(["a", "new"], ["a", "gone", "a"])
    expect(idsOf(selectionToolbar)).toEqual([
      "a",

      "translate",
      "default-dictionary",
      "default-sentence-analysis",
      "default-improve-writing",
      "new",
    ])
  })
})

describe("reorderSelectionToolbarItems", () => {
  it("saves the new order and keeps the custom actions' own list in step", () => {
    const selectionToolbar = toolbarWith(["a", "b", "c"])
    const order = [
      "c",
      "translate",
      "a",

      "default-improve-writing",
      "default-dictionary",
      "b",
      "default-sentence-analysis",
    ]
    const next = reorderSelectionToolbarItems(selectionToolbar, order)

    expect(next.order).toEqual(order)
    expect(next.customActions.map((action) => action.id)).toEqual(["c", "a", "b"])
    expect(idsOf(next)).toEqual(order)
    // The input is not touched.
    expect(selectionToolbar.customActions.map((action) => action.id)).toEqual(["a", "b", "c"])
  })
})

describe("setSelectionToolbarCustomActions", () => {
  it("moves the custom actions within their own places in the toolbar order", () => {
    const selectionToolbar = toolbarWith(
      ["a", "b", "c"],
      ["a", "translate", "b", "c", "default-dictionary", "default-sentence-analysis"],
    )
    const [a, b, c] = selectionToolbar.customActions
    const next = setSelectionToolbarCustomActions(selectionToolbar, [c!, a!, b!])

    expect(next.customActions.map((action) => action.id)).toEqual(["c", "a", "b"])
    expect(next.order).toEqual([
      "c",
      "translate",
      "a",

      "b",
      "default-dictionary",
      "default-sentence-analysis",
      "default-improve-writing",
    ])
  })

  it("places an action the order does not name yet after the rest", () => {
    const selectionToolbar = toolbarWith(["a"], ["a", "translate"])
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    const added = { ...dictionary, id: "added", name: "added" }
    const next = setSelectionToolbarCustomActions(selectionToolbar, [
      ...selectionToolbar.customActions,
      added,
    ])
    expect(next.order.at(-1)).toBe("added")
  })
})

describe("setSelectionToolbarItemPinned", () => {
  it("unpins and pins an item through the unpinned list, once each", () => {
    // Improve Writing starts unpinned.
    const unpinned = setSelectionToolbarItemPinned(toolbarWith(), "translate", false)
    expect(unpinned.unpinned).toEqual(["default-improve-writing", "translate"])
    expect(setSelectionToolbarItemPinned(unpinned, "translate", false).unpinned).toEqual([
      "default-improve-writing",
      "translate",
    ])
    expect(setSelectionToolbarItemPinned(unpinned, "translate", true).unpinned).toEqual([
      "default-improve-writing",
    ])
  })

  it("leaves the item's enabled switch alone, so the pin outlives turning it off and on", () => {
    const selectionToolbar = toolbarWith(["a"])
    const next = setSelectionToolbarItemPinned(selectionToolbar, "a", false)
    expect(next.customActions).toBe(selectionToolbar.customActions)
    expect(next.features).toBe(selectionToolbar.features)
    expect(next.builtInActions).toBe(selectionToolbar.builtInActions)

    next.customActions = [{ ...next.customActions[0]!, enabled: false }]
    next.customActions = [{ ...next.customActions[0]!, enabled: true }]
    expect(getSelectionToolbarItems(next).find((item) => item.id === "a")?.pinned).toBe(false)
  })
})
