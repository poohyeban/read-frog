// @vitest-environment jsdom
import type { ThemeMode } from "@/types/config/theme"
import { createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { baseThemeModeAtom } from "../theme"

const mocks = vi.hoisted(() => ({
  get: vi.fn<() => Promise<ThemeMode>>(),
  alive: true,
}))
vi.mock("../storage-adapter", () => ({ storageAdapter: { get: mocks.get, watch: () => () => {} } }))
vi.mock("@/utils/error/extension-context", () => ({
  isExtensionContextAlive: () => mocks.alive,
  isExtensionContextInvalidatedError: () => !mocks.alive,
}))
let unmount: (() => void) | undefined
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  unmount?.()
  mocks.alive = true
  vi.clearAllMocks()
})

describe("theme visibility refresh", () => {
  it("retains the theme when an in-flight read loses its extension context", async () => {
    let rejectRead!: (error: Error) => void
    mocks.get.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject
        }),
    )
    const store = createStore()
    store.set(baseThemeModeAtom, "dark")
    unmount = store.sub(baseThemeModeAtom, () => {})
    mocks.alive = false
    rejectRead(new Error("Extension context invalidated."))
    await tick()
    document.dispatchEvent(new Event("visibilitychange"))
    await tick()
    expect(store.get(baseThemeModeAtom)).toBe("dark")
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it("continues refreshing on tab activation while the context is healthy", async () => {
    mocks.get.mockResolvedValueOnce("dark").mockResolvedValueOnce("light")
    const store = createStore()
    unmount = store.sub(baseThemeModeAtom, () => {})
    await tick()
    expect(store.get(baseThemeModeAtom)).toBe("dark")
    document.dispatchEvent(new Event("visibilitychange"))
    await tick()
    expect(store.get(baseThemeModeAtom)).toBe("light")
  })
})
