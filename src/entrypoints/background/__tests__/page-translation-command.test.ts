import { beforeEach, describe, expect, it, vi } from "vitest"
import { browser } from "#imports"
const rpc = vi.hoisted(() => ({ send: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/message", () => ({ sendMessage: rpc.send }))
import { createPageTranslationCommandBridge } from "../page-translation-command"

const url = "https://example.com/video"
const request = { tabId: 7, url }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
describe("page command concurrent reads and document generations", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    browser.tabs.get = vi.fn<(...args: any[]) => any>(async () => ({ id: 7, url })) as any
  })
  it("multiple readers do not cancel a valid write confirmation", async () => {
    const bridge = createPageTranslationCommandBridge()
    const applied = deferred<{ enabled: boolean; url: string }>()
    rpc.send.mockImplementation((type) =>
      type === "applyPageTranslationCommand"
        ? applied.promise
        : Promise.resolve({ enabled: false, url }),
    )
    const write = bridge.request({ ...request, enabled: true })
    await vi.waitFor(() => expect(rpc.send).toHaveBeenCalledOnce())
    const reads = await Promise.all([bridge.request(request), bridge.request(request)])
    expect(reads).toEqual([
      { enabled: false, url },
      { enabled: false, url },
    ])
    applied.resolve({ enabled: true, url })
    await expect(write).resolves.toEqual({ enabled: true, url })
  })
  it("a write invalidates an older read even after the write finishes", async () => {
    const bridge = createPageTranslationCommandBridge()
    const old = deferred<{ enabled: boolean; url: string }>()
    rpc.send.mockImplementation((type) =>
      type === "getAppliedPageTranslationState"
        ? old.promise
        : Promise.resolve({ enabled: true, url }),
    )
    const read = bridge.request(request).catch((error) => error)
    await vi.waitFor(() => expect(rpc.send).toHaveBeenCalledOnce())
    await bridge.request({ ...request, enabled: true })
    old.resolve({ enabled: false, url })
    expect(await read).toBeInstanceOf(Error)
  })
  it.each([undefined, true])(
    "rejects old read/write receipts on same-URL reload (enabled=%s)",
    async (enabled) => {
      const bridge = createPageTranslationCommandBridge()
      const old = deferred<{ enabled: boolean; url: string }>()
      rpc.send.mockReturnValueOnce(old.promise)
      const pending = bridge.request({ ...request, enabled }).catch((error) => error)
      await vi.waitFor(() => expect(rpc.send).toHaveBeenCalledOnce())
      bridge.invalidate(7)
      rpc.send.mockResolvedValue({ enabled: false, url })
      await expect(bridge.request(request)).resolves.toEqual({ enabled: false, url })
      old.resolve({ enabled: true, url })
      expect(await pending).toBeInstanceOf(Error)
    },
  )
})
