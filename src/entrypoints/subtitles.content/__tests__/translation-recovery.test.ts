// @vitest-environment jsdom
import type { Config } from "@/types/config/config"
import type { SubtitlesFragment, SubtitlesState } from "@/utils/subtitles/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { translateSubtitles } from "@/utils/subtitles/processor/translator"
import { TranslationCoordinator } from "../translation-coordinator"

vi.mock("@/utils/config/storage", () => ({ getLocalConfig: vi.fn<typeof getLocalConfig>() }))
vi.mock("@/utils/subtitles/processor/translator", () => ({
  translateSubtitles: vi.fn<typeof translateSubtitles>(),
}))

const coordinators: TranslationCoordinator[] = []

function setup(fragments: SubtitlesFragment[], currentTime = 0) {
  const video = document.createElement("video")
  video.currentTime = currentTime
  let state: SubtitlesState = "idle"
  const onStateChange = vi.fn<(next: SubtitlesState) => void>((next) => {
    state = next
  })
  const onTranslated = vi.fn<(translated: SubtitlesFragment[]) => void>((translated) => {
    for (const fragment of translated) {
      const target = fragments.find((candidate) => candidate.start === fragment.start)
      if (target) Object.assign(target, fragment)
    }
  })
  const coordinator = new TranslationCoordinator({
    getFragments: () => fragments,
    getVideoElement: () => video,
    getCurrentState: () => state,
    segmentationPipeline: null,
    onTranslated,
    onStateChange,
  })
  coordinators.push(coordinator)
  return { coordinator, video, onTranslated, onStateChange }
}

beforeEach(() => {
  vi.mocked(getLocalConfig).mockResolvedValue(structuredClone(DEFAULT_CONFIG))
  vi.mocked(translateSubtitles).mockImplementation(async (fragments) =>
    fragments.map((fragment) => ({ ...fragment, translation: "translated" })),
  )
})
afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.stop()
  vi.resetAllMocks()
})

describe("subtitle translation recovery", () => {
  it("translates the currently visible long cue after seeking beyond its first five seconds", async () => {
    const fragments = [{ text: "A long sentence that is still visible.", start: 0, end: 25_000 }]
    const { coordinator, onTranslated } = setup(fragments, 12)
    coordinator.start()
    await vi.waitFor(() => expect(onTranslated).toHaveBeenCalled())
    expect(fragments[0]).toHaveProperty("translation", "translated")
  })

  it("settles failed cues even when extension storage is unavailable", async () => {
    vi.mocked(getLocalConfig).mockRejectedValue(new Error("Extension context invalidated."))
    vi.mocked(translateSubtitles).mockRejectedValue(new Error("Extension context invalidated."))
    const fragments = [{ text: "Still visible after reload", start: 0, end: 10_000 }]
    const { coordinator, onStateChange } = setup(fragments)
    coordinator.start()
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalledWith("idle"))
    expect(fragments[0]).toHaveProperty("translation", "")
    expect(getLocalConfig).toHaveBeenCalledTimes(1)
  })

  it.each(["bilingual", "translationOnly"] as const)(
    "uses the captured %s display mode when a later API request fails",
    async (displayMode) => {
      const config: Config = {
        ...DEFAULT_CONFIG,
        videoSubtitles: {
          ...DEFAULT_CONFIG.videoSubtitles,
          style: { ...DEFAULT_CONFIG.videoSubtitles.style, displayMode },
        },
      }
      vi.mocked(getLocalConfig)
        .mockResolvedValueOnce(config)
        .mockRejectedValue(new Error("storage became unavailable"))
      vi.mocked(translateSubtitles).mockRejectedValue(new Error("translation failed"))
      const fragments = [{ text: "Keep the original readable", start: 0, end: 10_000 }]
      const { coordinator, onStateChange } = setup(fragments)
      coordinator.start()
      await vi.waitFor(() => expect(onStateChange).toHaveBeenCalledWith("error", expect.anything()))
      expect(fragments[0]).toHaveProperty(
        "translation",
        displayMode === "translationOnly" ? fragments[0]!.text : "",
      )
      expect(getLocalConfig).toHaveBeenCalledTimes(1)
      expect(translateSubtitles).toHaveBeenCalledWith(expect.anything(), expect.anything(), config)
    },
  )

  it("does not start a request if stopped while configuration is loading", async () => {
    let finishConfig!: (config: Config) => void
    vi.mocked(getLocalConfig).mockReturnValue(
      new Promise((resolve) => {
        finishConfig = resolve
      }),
    )
    const { coordinator } = setup([{ text: "stopped", start: 0, end: 1000 }])
    coordinator.start()
    coordinator.stop()
    finishConfig(DEFAULT_CONFIG)
    await Promise.resolve()
    await Promise.resolve()
    expect(translateSubtitles).not.toHaveBeenCalled()
  })
})
