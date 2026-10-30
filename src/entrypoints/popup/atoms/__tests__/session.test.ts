import { createStore } from "jotai"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
const api = vi.hoisted(() => ({
  query: vi.fn<() => Promise<{ id: number; url: string }[]>>(),
  message: vi.fn<(type: string, data?: unknown) => Promise<boolean | undefined>>(),
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
    storage.watch = api.watch
    api.query.mockResolvedValue([{ id: 7, url: "https://example.com/a" }])
    api.message.mockResolvedValue(true)
    api.watch.mockReturnValue(api.unwatch)
  })
  afterEach(() => vi.useRealTimers())
  it("captures one tab and leaves unknown translation state non-interactive", async () => {
    let resolve!: (enabled: boolean) => void
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
    resolve(true)
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
    api.message.mockResolvedValue(false)
    const store = createStore()
    const session = createPopupSession(store)
    await session.start()
    store.get(togglePageTranslationAtom).run()
    store.get(togglePageTranslationAtom).run()
    await flush()
    expect(store.get(pageStatusAtom)).toEqual({ phase: "pending", enabled: false })
    expect(
      api.message.mock.calls.filter((c) => c[0] === "tryToSetEnablePageTranslationByTabId"),
    ).toHaveLength(1)
    api.message.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: true })
    session.dispose()
    expect(api.unwatch).toHaveBeenCalledOnce()
  })
  it("does not let a timed-out old read overwrite a successful retry", async () => {
    let resolve!: (enabled: boolean) => void
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
    resolve(false)
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
})
