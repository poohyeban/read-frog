import { afterEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
import { storageAdapter } from "../../config/storage-adapter"

const liveRuntimeId = browser.runtime.id

afterEach(() => {
  Object.defineProperty(browser.runtime, "id", { configurable: true, value: liveRuntimeId })
  vi.restoreAllMocks()
  storage.unwatch()
})

describe("storage subscription teardown", () => {
  it("can finish cleanup after an extension update removes the storage API", () => {
    const stop = storageAdapter.watch("theme", () => {})
    Object.defineProperty(browser.runtime, "id", { configurable: true, value: undefined })
    const remove = vi
      .spyOn(browser.storage.local.onChanged, "removeListener")
      .mockImplementation(() => {
        throw new Error("'wxt/storage' must be loaded in a web extension environment")
      })
    expect(stop).not.toThrow()
    expect(remove).toHaveBeenCalledOnce()
  })

  it("does not suppress unrelated cleanup failures in a live extension", () => {
    const stop = storageAdapter.watch("theme", () => {})
    vi.spyOn(browser.storage.local.onChanged, "removeListener").mockImplementation(() => {
      throw new Error("unexpected storage failure")
    })
    expect(stop).toThrow("unexpected storage failure")
  })
})
