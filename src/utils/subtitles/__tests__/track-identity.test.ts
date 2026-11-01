import { afterEach, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import * as hash from "@/utils/hash"
import { createSubtitleTrackIdentity } from "../track-identity"
const source = [{ start: 0, end: 1000, text: "hello" }]
const context = { videoTitle: "video", subtitlesTextContent: "" }
afterEach(() => vi.restoreAllMocks())
it("defers both full-track legacy hashes until compatibility lookup is necessary", () => {
  const legacyHash = vi.spyOn(hash, "safeLegacyFieldsHash")
  const identity = createSubtitleTrackIdentity("video", source, DEFAULT_CONFIG, context)
  expect(legacyHash).not.toHaveBeenCalled()
  const keys = identity.getLegacyTrackKeys()
  expect(keys).toHaveLength(3)
  expect(identity.getLegacyTrackKeys()).toBe(keys)
  expect(legacyHash).toHaveBeenCalledTimes(2)
})

it("captures source/context/config before deferral and retains the exact safe historical keys", async () => {
  const { subtitleCacheIdentity, legacySubtitleConfigIdentity } = await import("../config-identity")
  const config = structuredClone(DEFAULT_CONFIG),
    cues = structuredClone(source),
    ctx = { ...context }
  const original = JSON.stringify(cues),
    originalContext = JSON.stringify(ctx)
  const expected = [
    hash.Sha256Fields("video", original, subtitleCacheIdentity(config), originalContext),
    hash.safeLegacyFieldsHash("video", original, subtitleCacheIdentity(config), originalContext),
    hash.safeLegacyFieldsHash(
      "video",
      original,
      legacySubtitleConfigIdentity(config),
      originalContext,
    ),
  ]
  const identity = createSubtitleTrackIdentity("video", cues, config, ctx)
  config.language.targetCode = "jpn"
  cues[0]!.text = "edited"
  ctx.videoTitle = "edited"
  expect(identity.getLegacyTrackKeys()).toEqual(expected)
})
it.each(["credentials", "language", "context"])(
  "does not share current or historical identity across %s",
  (change) => {
    const config = structuredClone(DEFAULT_CONFIG),
      ctx = { ...context }
    const before = createSubtitleTrackIdentity("video", source, config, ctx)
    if (change === "credentials")
      Object.assign(config.providersConfig[0]!, { apiKey: "different-account" })
    if (change === "language") config.language.targetCode = "jpn"
    if (change === "context") ctx.videoTitle = "different topic"
    const after = createSubtitleTrackIdentity("video", source, config, ctx)
    expect(after.trackKey).not.toBe(before.trackKey)
    expect(
      after.getLegacyTrackKeys().some((key) => before.getLegacyTrackKeys().includes(key)),
    ).toBe(false)
  },
)
it("retains the unambiguous previous version but never delimiter-ambiguous historical identities", () => {
  const identity = createSubtitleTrackIdentity(
    "video",
    [{ ...source[0]!, text: "pipe|text" }],
    DEFAULT_CONFIG,
    context,
  )
  expect(identity.getLegacyTrackKeys()).toEqual([
    identity.trackKey.slice("subtitle-track-v3:".length),
  ])
})
