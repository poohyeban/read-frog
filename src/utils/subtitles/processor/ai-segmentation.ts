import type { SubtitleTaskOptions } from "../session"
import type { SubtitlesFragment } from "../types"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { PAUSE_TIMEOUT_MS } from "@/utils/constants/subtitles"
import { sendMessage } from "@/utils/message"
import { assertSubtitleWindow } from "../work-policy"

const NEWLINE_PATTERN = /\n/g
const WHITESPACE_PATTERN = /\s+/g
const VTT_TIMESTAMP_PATTERN = /^(-?\d+(?:\.\d+)?)\s*-->\s*(-?\d+(?:\.\d+)?)$/

const SEGMENTATION_PUNCTUATION = /[\p{P}\s]/gu

function normalizeSegmentationText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(SEGMENTATION_PUNCTUATION, "")
}

/** New protocol: the model chooses source indices; only trusted source data supplies time. */
export function decodeIndexedSegmentation(
  source: SubtitlesFragment[],
  response: string,
): SubtitlesFragment[] {
  const cleaned = response.replace(/```(?:json)?/g, "").trim()
  if (!cleaned.startsWith("{")) {
    // Compatibility with validated older providers/caches. Never accept free timestamps.
    const legacy = parseSimplifiedVttToFragments(cleaned)
    if (!isSegmentationAligned(source, legacy))
      throw new Error("AI segmentation does not match the source timeline")
    return legacy
  }
  const value: unknown = JSON.parse(cleaned)
  if (
    !value ||
    typeof value !== "object" ||
    !("segments" in value) ||
    !Array.isArray(value.segments)
  )
    throw new Error("Invalid segmentation protocol")
  let cursor = 0
  const result: SubtitlesFragment[] = []
  for (const segment of value.segments) {
    if (
      !segment ||
      !Number.isInteger(segment.from) ||
      !Number.isInteger(segment.to) ||
      segment.from !== cursor ||
      segment.to < cursor ||
      segment.to >= source.length ||
      typeof segment.text !== "string"
    )
      throw new Error("Invalid segmentation source coverage")
    const fragments = source.slice(segment.from, segment.to + 1)
    if (
      normalizeSegmentationText(segment.text) !==
      fragments.map((c) => normalizeSegmentationText(c.text)).join("")
    )
      throw new Error("AI segmentation changed source text")
    let coveredEnd = fragments[0]!.end
    for (const fragment of fragments.slice(1)) {
      if (fragment.start - coveredEnd > PAUSE_TIMEOUT_MS)
        throw new Error("AI segmentation crossed silence")
      coveredEnd = Math.max(coveredEnd, fragment.end)
    }
    result.push({ start: fragments[0]!.start, end: coveredEnd, text: segment.text })
    cursor = segment.to + 1
  }
  if (cursor !== source.length || !result.length)
    throw new Error("Incomplete segmentation source coverage")
  return result
}

/** AI may group fragments and add punctuation, but must preserve their timeline. */
export function isSegmentationAligned(
  source: SubtitlesFragment[],
  segmented: SubtitlesFragment[],
): boolean {
  if (source.length === 0 || segmented.length === 0) return false
  let cursor = 0
  for (const cue of segmented) {
    const first = source[cursor]
    if (!first || cue.start !== first.start || cue.end <= cue.start) return false
    const target = normalizeSegmentationText(cue.text)
    let text = ""
    let coveredEnd = first.end
    let matched = false
    for (; cursor < source.length; cursor++) {
      const fragment = source[cursor]!
      if (cursor > 0 && text && fragment.start - coveredEnd > PAUSE_TIMEOUT_MS) {
        return false
      }
      text += normalizeSegmentationText(fragment.text)
      coveredEnd = Math.max(coveredEnd, fragment.end)
      if (!target.startsWith(text)) return false
      if (text === target && cue.end === coveredEnd) {
        cursor++
        matched = true
        break
      }
    }
    if (!matched) return false
  }
  return cursor === source.length
}

export function cleanFragmentsForAi(fragments: SubtitlesFragment[]): SubtitlesFragment[] {
  return fragments
    .map((fragment) => ({
      ...fragment,
      text: fragment.text.replace(NEWLINE_PATTERN, " ").replace(WHITESPACE_PATTERN, " ").trim(),
    }))
    .filter((fragment) => fragment.text.length > 0)
}

export function formatFragmentsToJson(fragments: SubtitlesFragment[]): string {
  return JSON.stringify(
    fragments.map((f) => ({
      s: f.start,
      e: f.end,
      t: f.text,
    })),
  )
}

/**
 * Parse simplified VTT content returned from AI to fragments
 * Format:
 * WEBVTT
 *
 * 1000 --> 1500
 * Hello world.
 *
 * 2000 --> 3500
 * This is a sentence.
 */
export function parseSimplifiedVttToFragments(vtt: string): SubtitlesFragment[] {
  const fragments: SubtitlesFragment[] = []
  const lines = vtt.trim().split("\n")

  let lineIndex = 0
  // Skip WEBVTT header
  while (lineIndex < lines.length && !lines[lineIndex]!.includes("-->")) {
    lineIndex++
  }

  while (lineIndex < lines.length) {
    const line = lines[lineIndex]!.trim()

    // Match timestamp line: "1000 --> 1500" (milliseconds format)
    const match = line.match(VTT_TIMESTAMP_PATTERN)
    if (match) {
      const start = Number.parseInt(match[1]!, 10)
      const end = Number.parseInt(match[2]!, 10)

      // Collect text lines
      const textLines: string[] = []
      lineIndex++
      while (
        lineIndex < lines.length &&
        lines[lineIndex]!.trim() !== "" &&
        !lines[lineIndex]!.includes("-->")
      ) {
        textLines.push(lines[lineIndex]!.trim())
        lineIndex++
      }

      if (textLines.length > 0) {
        fragments.push({
          text: textLines.join("\n"),
          start,
          end,
        })
      }
    } else {
      lineIndex++
    }
  }

  return fragments
}

export async function aiSegmentBlock(
  fragments: SubtitlesFragment[],
  providerRef: PromptableProviderRef,
  task: SubtitleTaskOptions = {},
): Promise<SubtitlesFragment[]> {
  if (fragments.length === 0) {
    return fragments
  }

  const cleanedFragments = cleanFragmentsForAi(fragments)

  if (cleanedFragments.length === 0) {
    return fragments
  }

  const jsonContent = formatFragmentsToJson(cleanedFragments)
  assertSubtitleWindow(cleanedFragments)

  task.signal?.throwIfAborted()
  const segmentedVtt = await sendMessage("aiSegmentSubtitles", {
    work:
      task.work ??
      (await task.prepareWork?.(
        "segmentation",
        Math.min(...cleanedFragments.map((c) => c.start)),
        Math.max(...cleanedFragments.map((c) => c.end)),
      )),
    jsonContent,
    providerRef,
    sessionId: task.sessionId,
    priority: task.priority,
  })

  task.signal?.throwIfAborted()
  const segmentedFragments = parseSimplifiedVttToFragments(segmentedVtt)

  if (segmentedFragments.length === 0) {
    throw new Error("AI segmentation returned empty result")
  }

  if (!isSegmentationAligned(cleanedFragments, segmentedFragments)) {
    throw new Error("AI segmentation does not match the source timeline")
  }

  return segmentedFragments
}
