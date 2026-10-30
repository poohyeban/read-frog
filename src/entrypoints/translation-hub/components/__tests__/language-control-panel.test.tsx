// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const detect = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>())
vi.mock("@/utils/content/language", () => ({ detectLanguage: detect }))
vi.mock("../../atoms", async () => {
  const { atom } = await import("jotai")
  return {
    sourceLangCodeAtom: atom("auto"),
    targetLangCodeAtom: atom("cmn"),
    inputTextAtom: atom(""),
    detectedSourceLangCodeAtom: atom<string | null>(null),
    detectedLangCodeAtom: atom("eng"),
    exchangeLangCodesAtom: atom(null, () => {}),
  }
})
vi.mock("../searchable-language-selector", () => ({ SearchableLanguageSelector: () => null }))
import { detectedSourceLangCodeAtom, inputTextAtom, sourceLangCodeAtom } from "../../atoms"
import { LanguageControlPanel } from "../language-control-panel"

describe("hub language detection lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    detect.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })
  it("does no detection for empty input or an explicitly chosen source language", async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <LanguageControlPanel />
      </Provider>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(detect).not.toHaveBeenCalled()
    act(() => {
      void store.set(sourceLangCodeAtom, "eng")
      store.set(inputTextAtom, "Some text")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(detect).not.toHaveBeenCalled()
  })
  it("ignores a slow detection after the input changes", async () => {
    let finish!: (language: string) => void
    detect
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValue("jpn")
    const store = createStore()
    store.set(inputTextAtom, "First text")
    render(
      <Provider store={store}>
        <LanguageControlPanel />
      </Provider>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
      await vi.dynamicImportSettled()
    })
    act(() => {
      store.set(inputTextAtom, "Second text")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
      await vi.dynamicImportSettled()
    })
    expect(store.get(detectedSourceLangCodeAtom)).toBe("jpn")
    await act(async () => {
      finish("eng")
    })
    expect(store.get(detectedSourceLangCodeAtom)).toBe("jpn")
  })
  it("cancels the debounce when the page closes", async () => {
    const store = createStore()
    store.set(inputTextAtom, "Pending text")
    const view = render(
      <Provider store={store}>
        <LanguageControlPanel />
      </Provider>,
    )
    view.unmount()
    await vi.advanceTimersByTimeAsync(1500)
    expect(detect).not.toHaveBeenCalled()
  })
})
