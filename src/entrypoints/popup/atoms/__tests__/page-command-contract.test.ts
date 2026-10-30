import { createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
const rpc = vi.hoisted(() => ({ send: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/message", () => ({ sendMessage: rpc.send }))
import { createPageTranslationCommandBridge } from "@/entrypoints/background/page-translation-command"
import { applyPageCommand } from "@/entrypoints/content-runtime/host/translation-control/page-command"
import {
  createPopupSession,
  pageStatusAtom,
  retryPageStatusAtom,
  togglePageTranslationAtom,
} from "../session"

const url = "https://example.com/video"
const flush = () => vi.advanceTimersByTimeAsync(0)
function setup() {
  const bridge = createPageTranslationCommandBridge()
  const manager = {
    isActive: true,
    start: vi.fn<(...args: any[]) => any>(async () => {
      manager.isActive = true
    }),
    stop: vi.fn<(...args: any[]) => any>(() => {
      manager.isActive = false
    }),
  }
  let deliver: (() => void) | undefined
  let failure = false
  let href = url
  let saved: unknown
  browser.tabs.query = vi.fn<(...args: any[]) => any>(async () => [{ id: 7, url }]) as any
  browser.tabs.get = vi.fn<(...args: any[]) => any>(async () => ({ id: 7, url: href })) as any
  storage.setItem = vi.fn<(...args: any[]) => any>(async (_key, value) => {
    saved = value
  })
  storage.watch = vi.fn<(...args: any[]) => any>(() => () => {})
  rpc.send.mockImplementation(async (type, data, target) => {
    if (
      type === "getAppliedPageTranslationStateByTabId" ||
      type === "applyPageTranslationCommandByTabId"
    )
      return bridge.request(data)
    expect(target).toEqual({ tabId: 7, frameId: 0 })
    if (failure) throw new Error("Receiving end does not exist")
    if (type === "getAppliedPageTranslationState") return { enabled: manager.isActive, url: href }
    await new Promise<void>((resolve) => {
      deliver = resolve
    })
    return applyPageCommand(manager, data, () => href)
  })
  const store = createStore()
  const session = createPopupSession(store)
  return {
    manager,
    bridge,
    store,
    session,
    saved: () => saved,
    deliver: () => deliver?.(),
    fail: () => {
      failure = true
    },
    navigate: (next = url) => {
      bridge.invalidate(7)
      href = next
    },
  }
}
describe("Popup ↔ background ↔ manager completion contract", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())
  it("does not confirm stop from early persisted false; retains manual refusal", async () => {
    const t = setup()
    await t.session.start()
    t.store.get(togglePageTranslationAtom).run()
    t.store.get(togglePageTranslationAtom).run()
    await flush()
    expect(t.saved()).toEqual({ enabled: false, userDisabled: true, origin: "https://example.com" })
    expect(t.manager.isActive).toBe(true)
    expect(t.store.get(pageStatusAtom)).toEqual({ phase: "pending", enabled: true })
    expect(rpc.send.mock.calls.filter((c) => c[0] === "applyPageTranslationCommand")).toHaveLength(
      1,
    )
    t.deliver()
    await flush()
    expect(t.manager.stop).toHaveBeenCalledOnce()
    expect(t.store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: false })
    t.session.dispose()
  })
  it("times out a lost stop; retry reads applied state instead of persisted false", async () => {
    const t = setup()
    await t.session.start()
    t.store.get(togglePageTranslationAtom).run()
    await vi.advanceTimersByTimeAsync(2500)
    expect(t.saved()).toMatchObject({ enabled: false, userDisabled: true })
    expect(t.store.get(pageStatusAtom).phase).toBe("error")
    t.store.get(retryPageStatusAtom).run()
    await flush()
    expect(t.store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: true })
    t.deliver()
    await flush()
    expect(t.store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: true })
    t.session.dispose()
  })
  it("reports missing content receiver without undoing the manual refusal", async () => {
    const t = setup()
    await t.session.start()
    t.fail()
    t.store.get(togglePageTranslationAtom).run()
    await flush()
    expect(t.store.get(pageStatusAtom).phase).toBe("error")
    expect(t.saved()).toMatchObject({ userDisabled: true })
    t.session.dispose()
  })
  it.each([url, "https://example.com/other"])(
    "rejects completion after navigation to %s",
    async (next) => {
      const t = setup()
      await t.session.start()
      t.store.get(togglePageTranslationAtom).run()
      await flush()
      t.navigate(next)
      t.deliver()
      await flush()
      expect(t.store.get(pageStatusAtom).phase).toBe("error")
      t.session.dispose()
    },
  )
  it("ignores completion after Popup closes", async () => {
    const t = setup()
    await t.session.start()
    t.store.get(togglePageTranslationAtom).run()
    await flush()
    t.session.dispose()
    t.deliver()
    await flush()
    expect(t.store.get(pageStatusAtom).phase).toBe("pending")
  })
  it("waits for actual start and rejects a manager that could not activate", async () => {
    const manager = {
      isActive: false,
      start: vi.fn<(...args: any[]) => any>(async () => {}),
      stop: vi.fn<(...args: any[]) => any>(),
    }
    await expect(applyPageCommand(manager, { enabled: true, url }, () => url)).rejects.toThrow(
      "did not apply",
    )
    manager.start.mockImplementation(async () => {
      manager.isActive = true
    })
    await expect(applyPageCommand(manager, { enabled: true, url }, () => url)).resolves.toEqual({
      enabled: true,
      url,
    })
  })
  it("stops even when an inactive manager has a pending start", async () => {
    const manager = {
      isActive: false,
      start: vi.fn<(...args: any[]) => any>(),
      stop: vi.fn<(...args: any[]) => any>(),
    }
    await applyPageCommand(manager, { enabled: false, url }, () => url)
    expect(manager.stop).toHaveBeenCalledWith({ userInitiated: true })
  })
  it("opening a second Popup while stopping does not invalidate the first Popup's confirmation", async () => {
    const t = setup()
    await t.session.start()
    t.store.get(togglePageTranslationAtom).run()
    await flush()
    const secondStore = createStore()
    const second = createPopupSession(secondStore)
    await second.start()
    secondStore.get(retryPageStatusAtom).run()
    await flush()
    expect(t.store.get(pageStatusAtom)).toEqual({ phase: "pending", enabled: true })
    t.deliver()
    await flush()
    expect(t.store.get(pageStatusAtom)).toEqual({ phase: "ready", enabled: false })
    t.session.dispose()
    second.dispose()
  })
})
