import type { SubtitlesFragment } from "../types"
import type { VideoSummaryProviderRef } from "../video-summary"
import { hashKey } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  buildTranscript,
  sampleTranscript,
  stripLeadingHeading,
  videoSummaryQueryKey,
} from "../video-summary"

function fragment(text: string): SubtitlesFragment {
  return { text, start: 0, end: 1000 }
}

describe("buildTranscript", () => {
  it("keeps one line per cue and drops blank ones", () => {
    expect(buildTranscript([fragment("first"), fragment("   "), fragment("second")])).toBe(
      "first\nsecond",
    )
  })

  it("strips zero-width characters", () => {
    expect(buildTranscript([fragment("a​b﻿")])).toBe("ab")
  })

  it("does not truncate long transcripts", () => {
    const long = Array.from({ length: 400 }, () => fragment("x".repeat(50)))

    expect(buildTranscript(long)).toHaveLength(400 * 50 + 399)
  })
})

describe("stripLeadingHeading", () => {
  it("removes a title the model added despite being told not to", () => {
    expect(stripLeadingHeading("## A Title\n\nThe body.")).toBe("The body.")
  })

  it("keeps headings the summary itself uses further down", () => {
    const summary = "Opening.\n\n## A section\nMore."

    expect(stripLeadingHeading(summary)).toBe(summary)
  })

  it("leaves an answer that opens with prose alone", () => {
    expect(stripLeadingHeading("Just prose.")).toBe("Just prose.")
  })
})

function localRef(model: string): NonNullable<VideoSummaryProviderRef> {
  const config = {
    ...DEFAULT_PROVIDER_CONFIG.openai,
    model: { ...DEFAULT_PROVIDER_CONFIG.openai.model, isCustomModel: true, customModel: model },
  }
  return { kind: "local", id: config.id, name: config.name, config }
}
describe("videoSummaryQueryKey", () => {
  it("separates video, language and edited provider models", () => {
    const ref = localRef("v1")
    const base = hashKey(videoSummaryQueryKey("video-1", "cmn", ref))
    for (const key of [
      videoSummaryQueryKey("video-2", "cmn", ref),
      videoSummaryQueryKey("video-1", "eng", ref),
      videoSummaryQueryKey("video-1", "cmn", localRef("v2")),
    ])
      expect(hashKey(key)).not.toBe(base)
    expect(hashKey(videoSummaryQueryKey("video-1", "cmn", localRef("v1")))).toBe(base)
  })
})

describe("sampleTranscript", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`)

  it("leaves a transcript that already fits untouched", () => {
    const transcript = "one\ntwo\nthree"

    expect(sampleTranscript(transcript, 100)).toBe(transcript)
  })

  it("stays inside the budget once the transcript exceeds it", () => {
    const transcript = lines(400).join("\n")

    expect(sampleTranscript(transcript, 500).length).toBeLessThanOrEqual(500)
  })

  it("reaches the end of the video rather than only its opening", () => {
    const transcript = lines(400).join("\n")
    const sampled = sampleTranscript(transcript, 500)

    expect(sampled).toContain("line 0")
    expect(sampled).toContain("line 200")
    expect(sampled).toContain("line 350")
  })

  it("keeps every sampled cue whole", () => {
    const transcript = lines(400).join("\n")
    const source = new Set(lines(400))

    for (const cue of sampleTranscript(transcript, 500).split("\n").filter(Boolean)) {
      expect(source.has(cue)).toBe(true)
    }
  })
})
