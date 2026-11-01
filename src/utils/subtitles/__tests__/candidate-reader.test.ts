import { afterEach, expect, it, vi } from "vitest"
import { sendMessage } from "@/utils/message"
import { createSubtitleCandidateReader } from "../candidate-reader"
vi.mock("@/utils/message", () => ({ sendMessage: vi.fn<typeof sendMessage>() }))
afterEach(() => vi.resetAllMocks())
const setup = () => {
  const getLegacyTrackKeys = vi.fn<() => string[]>(() => ["safe-old", "older"])
  return {
    getLegacyTrackKeys,
    read: createSubtitleCandidateReader({ trackKey: "new", getLegacyTrackKeys }),
  }
}
it("does no historical hashing or extra IPC for an empty/current-only cache", async () => {
  const { read, getLegacyTrackKeys } = setup()
  vi.mocked(sendMessage).mockResolvedValue({ bundles: [], mayHaveLegacy: false })
  expect(await read(0, 60000)).toEqual([])
  expect(await read(60000, 120000)).toEqual([])
  expect(getLegacyTrackKeys).not.toHaveBeenCalled()
  expect(sendMessage).toHaveBeenCalledTimes(2)
})
it("combines current and historical hits even when the current window is partially cached", async () => {
  const { read, getLegacyTrackKeys } = setup()
  const current = { key: "current-part" },
    legacy = { key: "legacy-part" }
  vi.mocked(sendMessage)
    .mockResolvedValueOnce({ bundles: [current], mayHaveLegacy: true } as never)
    .mockResolvedValue([current, legacy] as never)
  expect(await read(0, 60000)).toEqual([current, legacy])
  expect(await read(60000, 120000)).toEqual([current, legacy])
  expect(getLegacyTrackKeys).toHaveBeenCalledTimes(1)
  expect(sendMessage).toHaveBeenLastCalledWith("getSubtitleCandidates", {
    trackKey: "new",
    legacyTrackKeys: ["safe-old", "older"],
    start: 60000,
    end: 120000,
  })
  expect(sendMessage).toHaveBeenCalledTimes(3)
})
it("rechecks absence so a later historical record from another tab can be recovered", async () => {
  const { read, getLegacyTrackKeys } = setup()
  vi.mocked(sendMessage)
    .mockResolvedValueOnce({ bundles: [], mayHaveLegacy: false })
    .mockResolvedValueOnce({ bundles: [], mayHaveLegacy: true })
    .mockResolvedValue([])
  await read(0, 60000)
  await read(60000, 120000)
  expect(getLegacyTrackKeys).toHaveBeenCalledTimes(1)
  expect(sendMessage).toHaveBeenCalledTimes(3)
})
it("does not compute compatibility keys or issue another read after cancellation", async () => {
  const { read, getLegacyTrackKeys } = setup()
  const controller = new AbortController()
  vi.mocked(sendMessage).mockImplementation(async () => {
    controller.abort()
    return { bundles: [], mayHaveLegacy: true }
  })
  await expect(read(0, 60000, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  expect(sendMessage).toHaveBeenCalledTimes(1)
  expect(getLegacyTrackKeys).not.toHaveBeenCalled()
})
