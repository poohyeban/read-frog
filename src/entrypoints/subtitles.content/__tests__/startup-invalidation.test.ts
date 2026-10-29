// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browser, ContentScriptContext } from "#imports"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { initI18n } from "@/utils/i18n"
import entrypoint from "../index"
import { bootstrapSubtitlesRuntime } from "../runtime"

vi.mock("@/utils/iconify/local-icons", () => ({}))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: vi.fn<typeof getLocalConfig>() }))
vi.mock("@/utils/i18n", () => ({ initI18n: vi.fn<typeof initI18n>() }))
vi.mock("../runtime", () => ({
  bootstrapSubtitlesRuntime: vi.fn<typeof bootstrapSubtitlesRuntime>(),
}))

let ctx: ContentScriptContext
beforeEach(() => {
  vi.resetAllMocks()
  window.__READ_FROG_SUBTITLES_INJECTED__ = false
  Object.defineProperty(browser.runtime, "id", { configurable: true, value: "test-extension" })
  ctx = new ContentScriptContext("subtitles")
  vi.mocked(getLocalConfig).mockResolvedValue({
    ...DEFAULT_CONFIG,
    videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, enabled: true },
  })
  vi.mocked(initI18n).mockResolvedValue(undefined)
})
afterEach(() => ctx.abort())

describe("subtitle startup lifecycle", () => {
  it("does not leave a rejected storage read or an injection flag after invalidation", async () => {
    vi.mocked(getLocalConfig).mockRejectedValue(new Error("Extension context invalidated."))
    await expect(entrypoint.main(ctx)).resolves.toBeUndefined()
    expect(ctx.isInvalid).toBe(true)
    expect(window.__READ_FROG_SUBTITLES_INJECTED__).toBe(false)
    expect(bootstrapSubtitlesRuntime).not.toHaveBeenCalled()
  })

  it("does not load the runtime when invalidated during asynchronous initialization", async () => {
    const ready = Promise.withResolvers<void>()
    vi.mocked(initI18n).mockReturnValue(ready.promise)
    const starting = entrypoint.main(ctx)
    await vi.waitFor(() => expect(initI18n).toHaveBeenCalled())
    ctx.abort()
    ready.resolve()
    await starting
    expect(window.__READ_FROG_SUBTITLES_INJECTED__).toBe(false)
    expect(bootstrapSubtitlesRuntime).not.toHaveBeenCalled()
  })

  it("preserves unexpected startup failures for developer diagnostics", async () => {
    const failure = new Error("Unexpected storage failure")
    vi.mocked(getLocalConfig).mockRejectedValue(failure)
    await expect(entrypoint.main(ctx)).rejects.toBe(failure)
    expect(window.__READ_FROG_SUBTITLES_INJECTED__).toBe(false)
  })

  it("starts normally and releases the injection flag on teardown", async () => {
    await entrypoint.main(ctx)
    expect(bootstrapSubtitlesRuntime).toHaveBeenCalledWith(ctx)
    expect(window.__READ_FROG_SUBTITLES_INJECTED__).toBe(true)
    ctx.abort()
    expect(window.__READ_FROG_SUBTITLES_INJECTED__).toBe(false)
  })
})
