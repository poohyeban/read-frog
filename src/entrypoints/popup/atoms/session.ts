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
    const request = ++revision
    store.set(pageStatusAtom, { phase: "loading" })
    try {
      let tab = store.get(popupTabAtom)
      if (!tab) {
        const [found] = await withDeadline(
          browser.tabs.query({ active: true, currentWindow: true }),
        )
        if (!current(request)) return
        if (typeof found?.id !== "number" || !found.url) throw new Error("No active page")
        tab = { id: found.id, url: found.url }
        store.set(popupTabAtom, tab)
        unwatch = storage.watch(getTranslationStateKey(tab.id), () => {
          if (active && store.get(pageStatusAtom).phase !== "pending") void refresh()
        })
      }
      const applied = await read(tab)
      if (current(request)) store.set(pageStatusAtom, { phase: "ready", enabled: applied.enabled })
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

  store.set(retryPageStatusAtom, {
    run: () => {
      void refresh()
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
    },
  }
}
