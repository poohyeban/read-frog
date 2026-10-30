import type { createStore } from "jotai"
import { atom } from "jotai"
import { browser, storage } from "#imports"
import { getTranslationStateKey } from "@/utils/constants/storage-keys"
import { sendMessage } from "@/utils/message"

export type PopupTab = { id: number; url: string }
export type PageStatus =
  | { phase: "loading" | "error" }
  | { phase: "ready" | "pending"; enabled: boolean }
export const popupTabAtom = atom<PopupTab | null>(null)
export const pageStatusAtom = atom<PageStatus>({ phase: "loading" })
export const retryPageStatusAtom = atom<{ run: () => void }>({ run: () => {} })
export const togglePageTranslationAtom = atom<{ run: () => void }>({ run: () => {} })

/** Bound browser APIs that can remain unresolved after a worker/context failure. */
export async function withDeadline<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Popup request timed out")), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** A UI adapter to the existing background protocol, never a translation engine. */
export function createPopupSession(store: ReturnType<typeof createStore>) {
  let active = true
  let revision = 0
  let unwatch: (() => void) | undefined
  const current = (id: number) => active && id === revision
  const read = (tab: PopupTab) =>
    withDeadline(
      sendMessage("getAppliedPageTranslationStateByTabId", { tabId: tab.id, url: tab.url }),
    )

  async function refresh() {
    if (!active) return
    const request = ++revision
    store.set(pageStatusAtom, { phase: "loading" })
    try {
      let tab = store.get(popupTabAtom)
      let loading = false
      if (!tab) {
        const [found] = await withDeadline(
          browser.tabs.query({ active: true, currentWindow: true }),
        )
        if (!current(request)) return
        if (typeof found?.id !== "number" || !found.url) throw new Error("No active page")
        tab = { id: found.id, url: found.url }
        loading = found.status === "loading"
        store.set(popupTabAtom, tab)
        unwatch = storage.watch(getTranslationStateKey(tab.id), () => {
          if (active && store.get(pageStatusAtom).phase !== "pending") void refresh()
        })
      } else {
        // Stay bound to the original tab even if another tab becomes active.
        // The URL is a document snapshot and must be renewed on every retry.
        const found = await withDeadline(browser.tabs.get(tab.id))
        if (!current(request)) return
        if (!found.url) throw new Error("No current page")
        tab = { id: tab.id, url: found.url }
        loading = found.status === "loading"
        store.set(popupTabAtom, tab)
      }
      if (loading) return // tabs.onUpdated resumes when this document is ready.
      const applied = await read(tab)
      if (!current(request)) return
      if (applied.url !== tab.url) throw new Error("Page changed while reading translation")
      store.set(pageStatusAtom, { phase: "ready", enabled: applied.enabled })
    } catch {
      if (current(request)) store.set(pageStatusAtom, { phase: "error" })
    }
  }

  async function toggle() {
    const state = store.get(pageStatusAtom)
    const tab = store.get(popupTabAtom)
    if (!tab || state.phase !== "ready") return
    const request = ++revision
    const enabled = !state.enabled
    store.set(pageStatusAtom, { phase: "pending", enabled: state.enabled })
    try {
      const found = await withDeadline(browser.tabs.get(tab.id))
      if (!current(request)) return
      if (found.url !== tab.url || found.status === "loading") {
        await refresh()
        return
      }
      const applied = await withDeadline(
        sendMessage("applyPageTranslationCommandByTabId", { tabId: tab.id, url: tab.url, enabled }),
      )
      if (!current(request)) return
      if (applied.url !== tab.url || applied.enabled !== enabled)
        throw new Error("Translation command was not confirmed")
      store.set(pageStatusAtom, { phase: "ready", enabled })
    } catch {
      if (current(request)) store.set(pageStatusAtom, { phase: "error" })
    }
  }

  const onUpdated: Parameters<typeof browser.tabs.onUpdated.addListener>[0] = (tabId, change) => {
    if (!active || store.get(popupTabAtom)?.id !== tabId) return
    if (change.status === "loading" || change.url !== undefined) {
      revision++
      store.set(pageStatusAtom, { phase: "loading" })
    }
    if (change.status === "complete" || (change.url !== undefined && change.status !== "loading"))
      void refresh()
  }
  const onRemoved: Parameters<typeof browser.tabs.onRemoved.addListener>[0] = (tabId) => {
    if (!active || store.get(popupTabAtom)?.id !== tabId) return
    revision++
    store.set(pageStatusAtom, { phase: "error" })
  }
  browser.tabs.onUpdated.addListener(onUpdated)
  browser.tabs.onRemoved.addListener(onRemoved)

  store.set(retryPageStatusAtom, {
    run: () => {
      if (store.get(pageStatusAtom).phase !== "pending") void refresh()
    },
  })
  store.set(togglePageTranslationAtom, {
    run: () => {
      void toggle()
    },
  })
  return {
    start: refresh,
    dispose() {
      active = false
      revision++
      unwatch?.()
      browser.tabs.onUpdated.removeListener(onUpdated)
      browser.tabs.onRemoved.removeListener(onRemoved)
    },
  }
}
