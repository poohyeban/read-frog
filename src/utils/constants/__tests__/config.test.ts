import { afterEach, describe, expect, it, vi } from "vitest"
// Warm config's module graph at collection time, which has no timeout. Each test
// still re-imports it after vi.resetModules(), but no longer pays the cold load
// inside its 5s budget.
import "../config"

describe("dEFAULT_CONFIG", () => {
  const originalCrypto = globalThis.crypto

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    })
    vi.resetModules()
  })

  it("initializes when crypto.randomUUID is unavailable but crypto.getRandomValues exists", async () => {
    const getRandomValues = vi.fn<(...args: any[]) => any>((array: Uint8Array<ArrayBuffer>) =>
      originalCrypto.getRandomValues(array),
    )

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues,
      },
    })
    vi.resetModules()

    const { createDefaultDictionaryAction, createDefaultSentenceAnalysisAction, DEFAULT_CONFIG } =
      await import("../config")
    const defaultDictionaryAction = createDefaultDictionaryAction()
    const defaultSentenceAnalysisAction = createDefaultSentenceAnalysisAction()

    expect(defaultDictionaryAction).toEqual(
      expect.objectContaining({
        id: "default-dictionary",
        icon: "streamline-color:dictionary-language-book-flat",
      }),
    )
    expect(defaultSentenceAnalysisAction).toEqual(
      expect.objectContaining({
        id: "default-sentence-analysis",
        icon: "streamline-color:search-visual-flat",
      }),
    )
    expect(defaultDictionaryAction?.outputSchema).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "default-dictionary-term" })]),
    )
    expect(
      defaultDictionaryAction?.outputSchema.every(
        (field) => typeof field.id === "string" && field.id.length > 0,
      ),
    ).toBe(true)
    expect(DEFAULT_CONFIG.selectionToolbar.customActions).toEqual([])
  })

  it("defaults fresh hover translation off", async () => {
    const { DEFAULT_CONFIG } = await import("../config")

    expect(DEFAULT_CONFIG.pageTranslation.node.forceRetranslation).toBe(false)
  })
})
