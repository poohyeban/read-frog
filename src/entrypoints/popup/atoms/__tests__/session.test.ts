import { createStore } from "jotai"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
const api = vi.hoisted(() => ({
  query: vi.fn<() => Promise<{ id: number; url: string }[]>>(),
  addUpdated: vi.fn<(...args: any[]) => any>(),
  removeUpdated: vi.fn<(...args: any[]) => any>(),
  addRemoved: vi.fn<(...args: any[]) => any>(),
  removeRemoved: vi.fn<(...args: any[]) => any>(),
  get: vi.fn<() => Promise<{ id: number; url: string; status?: string }>>(),
  message: vi.fn<(type: string, data?: unknown) => Promise<{ enabled: boolean; url: string }>>(),
  watch: vi.fn<(key: string, callback: () => void) => () => void>(),
  unwatch: vi.fn<() => void>(),
}))
vi.mock("@/utils/message", () => ({ sendMessage: api.message }))
import {
  createPopupSession,
  pageStatusAtom,
  popupTabAtom,
  retryPageStatusAtom,
  togglePageTranslationAtom,
} from "../session"

const flush = () => vi.advanceTimersByTimeAsync(0)
describe("popup session", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    browser.tabs.query = api.query as unknown as typeof browser.tabs.query
    browser.tabs.get = api.get as unknown as typeof browser.tabs.get
    browser.tabs.onUpdated.addListener = api.addUpdated
    browser.tabs.onUpdated.removeListener = api.removeUpdated
    browser.tabs.onRemoved.addListener = api.addRemoved
    browser.tabs.onRemoved.removeListener = api.removeRemoved
    storage.watch = api.watch
    api.query.mockResolvedValue([{ id: 7, url: "https://example.com/a" }])
    api.get.mockResolvedValue({ id: 7, url: "https://example.com/a" })
    api.message.mockResolvedValue({ enabled: true, url: "https://example.com/a" })
    api.watch.mockReturnValue(api.unwatch)
  })
  afterEach(() => vi.useRealTimers())
  it("captures one tab and leaves unknown translation state non-interactive", async () => {
    let resolve!: (state: { enabled: boolean; url: string }) => void
    api.message.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const store = createStore()
    const session = createPopupSession(store)
    const ready = session.start()
    await flush()
    expect(store.get(popupTabAtom)?.id).toBe(7)
    expect(store.get(pageStatusAtom)).toEqual({ phase: "loading" })
    resolve({ enabled: true, url: "https://example.com/a" })
    await ready
    expect(store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: true })
    expect(api.query).toHaveBeenCalledTimes(1)
    session.dispose()
    expect(api.unwatch).toHaveBeenCalledOnce()
  })
  it("times out a sleeping/unavailable worker and retries without querying another tab", async () => {
    api.message.mockImplementationOnce(() => new Promise(() => {}))
    const store = createStore()
    const session = createPopupSession(store)
    const ready = session.start()
    await vi.advanceTimersByTimeAsync(2500)
    await ready
    expect(store.get(pageStatusAtom).phase).toBe("error")
    store.get(retryPageStatusAtom).run()
    await flush()
    expect(store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: true })
    expect(api.query).toHaveBeenCalledTimes(1)
    session.dispose()
  })
  it("requires authoritative confirmation, blocks duplicate clicks, and cancels on close", async () => {
    api.message.mockResolvedValue({ enabled: false, url: "https://example.com/a" })
    const store = createStore()
    const session = createPopupSession(store)
    await session.start()
    let finish!: (state: { enabled: boolean; url: string }) => void
    api.message.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    store.get(togglePageTranslationAtom).run()
    store.get(togglePageTranslationAtom).run()
    await flush()
    expect(store.get(pageStatusAtom)).toEqual({ phase: "pending", enabled: false })
    expect(
      api.message.mock.calls.filter((c) => c[0] === "applyPageTranslationCommandByTabId"),
    ).toHaveLength(1)
    finish({ enabled: true, url: "https://example.com/a" })
    await flush()
    expect(store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: true })
    session.dispose()
    expect(api.unwatch).toHaveBeenCalledOnce()
  })
  it("does not let a timed-out old read overwrite a successful retry", async () => {
    let resolve!: (state: { enabled: boolean; url: string }) => void
    api.message.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const store = createStore()
    const session = createPopupSession(store)
    const first = session.start()
    await vi.advanceTimersByTimeAsync(2500)
    await first
    store.get(retryPageStatusAtom).run()
    await flush()
    resolve({ enabled: false, url: "https://example.com/a" })
    await flush()
    expect(store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: true })
    session.dispose()
  })
  it("handles no tab and ignores results after disposal", async () => {
    api.query.mockResolvedValueOnce([])
    const store = createStore()
    const session = createPopupSession(store)
    await session.start()
    expect(store.get(pageStatusAtom).phase).toBe("error")
    session.dispose()
    expect(store.get(popupTabAtom)).toBeNull()
  })

  it("retry refreshes the bound tab URL after navigation without switching to another active tab", async () => {
    const store = createStore()
    const session = createPopupSession(store)
    await session.start()
    api.query.mockResolvedValue([{ id: 99, url: "https://unrelated.example/" }])
    api.get.mockResolvedValue({ id: 7, url: "https://example.com/b" })
    api.message.mockResolvedValue({ enabled: false, url: "https://example.com/b" })
    store.get(retryPageStatusAtom).run()
    await flush()
    expect(store.get(popupTabAtom)).toEqual({ id: 7, url: "https://example.com/b" })
    expect(api.message).toHaveBeenLastCalledWith("getAppliedPageTranslationStateByTabId", {
      tabId: 7,
      url: "https://example.com/b",
    })
    expect(store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: false })
    expect(api.query).toHaveBeenCalledOnce()
    session.dispose()
  })

  it.each(["https://example.com/a", "https://example.com/b"])(
    "invalidates an old receipt and synchronizes after navigation/reload to %s",
    async (url) => {
      const store = createStore()
      const session = createPopupSession(store)
      await session.start()
      let finish!: (state: { enabled: boolean; url: string }) => void
      api.message.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      store.get(togglePageTranslationAtom).run()
      await flush()
      const updated = api.addUpdated.mock.calls[0]![0]
      api.get.mockResolvedValue({ id: 7, url, status: "loading" })
      updated(7, { status: "loading" }, { id: 7, url } as any)
      await flush()
      expect(store.get(pageStatusAtom).phase).toBe("loading")
      api.get.mockResolvedValue({ id: 7, url, status: "complete" })
      api.message.mockResolvedValue({ enabled: true, url })
      updated(7, { status: "complete" }, { id: 7, url } as any)
      await flush()
      finish({ enabled: false, url: "https://example.com/a" })
      await flush()
      expect(store.get(popupTabAtom)).toEqual({ id: 7, url })
      expect(store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: true })
      session.dispose()
      expect(api.removeUpdated).toHaveBeenCalledWith(updated)
    },
  )

  it("never retargets a closed tab and never writes using a stale URL", async () => {
    const store = createStore()
    const session = createPopupSession(store)
    await session.start()
    api.get.mockResolvedValue({ id: 7, url: "https://example.com/b" })
    store.get(togglePageTranslationAtom).run()
    await flush()
    expect(
      api.message.mock.calls.some(([type]) => type === "applyPageTranslationCommandByTabId"),
    ).toBe(false)
    api.get.mockRejectedValue(new Error("No tab"))
    store.get(retryPageStatusAtom).run()
    await flush()
    expect(store.get(pageStatusAtom).phase).toBe("error")
    expect(api.query).toHaveBeenCalledOnce()
    session.dispose()
  })
})
