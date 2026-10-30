// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import {
  findStaleBilingualLayoutSource,
  registerBilingualTranslationState,
  unregisterBilingualTranslationState,
} from "../translation-state"

describe("mutation source validation budget", () => {
  it("reads a source once for 30 mutation targets, then checks again in the next batch", () => {
    const source = document.createElement("p")
    const text = document.createTextNode("Original source")
    source.append(text)
    document.body.append(source)
    const state = {
      layoutSource: source,
      sourceTextContent: "Original source",
      status: "active" as const,
      walkId: "walk",
      wrapper: null,
      wrapperTextContent: null,
    }
    registerBilingualTranslationState(state)
    text.data = "Changed source"
    const read = vi.spyOn(text, "data", "get")
    try {
      const checked = new WeakMap<HTMLElement, boolean>()
      for (let i = 0; i < 30; i++)
        expect(findStaleBilingualLayoutSource(text, checked)).toBe(source)
      expect(read).toHaveBeenCalledTimes(1)
      expect(findStaleBilingualLayoutSource(text, new WeakMap())).toBe(source)
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      read.mockRestore()
      unregisterBilingualTranslationState(state)
      source.remove()
    }
  })
})
