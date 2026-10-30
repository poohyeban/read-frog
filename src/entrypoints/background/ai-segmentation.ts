import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { z } from "zod"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { logger } from "@/utils/logger"
import { getSubtitlesSegmentationPrompt } from "@/utils/prompts/subtitles-segmentation"
import {
  canProviderRefGenerateText,
  getProviderCacheIdentity,
} from "@/utils/providers/provider-ref"
import {
  isSegmentationAligned,
  parseSimplifiedVttToFragments,
} from "@/utils/subtitles/processor/ai-segmentation"
import { generateTextForProviderRef } from "./background-stream"

const VTT_CODE_BLOCK_RE = /```vtt\n?/g
const CODE_BLOCK_RE = /```\n?/g
const THINK_TAG_RE = /<\/think>([\s\S]*)/
const inputFragmentsSchema = z.array(
  z.object({ s: z.number().nonnegative(), e: z.number().nonnegative(), t: z.string() }),
)

interface AiSegmentSubtitlesData {
  jsonContent: string
  providerRef: PromptableProviderRef
}

/**
 * Clean VTT response from AI (remove markdown code blocks, ensure WEBVTT header)
 */
function cleanVttResponse(text: string): string {
  let cleaned = text.trim()

  // Remove markdown code blocks
  cleaned = cleaned.replace(VTT_CODE_BLOCK_RE, "").replace(CODE_BLOCK_RE, "")

  // Handle thinking model output (strip <think> tags)
  const [, afterThink = cleaned] = cleaned.match(THINK_TAG_RE) || []
  cleaned = afterThink.trim()

  // Ensure starts with WEBVTT
  if (!cleaned.toUpperCase().startsWith("WEBVTT")) {
    cleaned = `WEBVTT\n\n${cleaned}`
  }

  return cleaned
}

/**
 * Run AI segmentation on JSON subtitle content
 */
export async function runAiSegmentSubtitles(
  data: AiSegmentSubtitlesData,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  options.signal?.throwIfAborted()
  const { jsonContent, providerRef } = data

  if (!jsonContent) {
    throw new Error("jsonContent is required for AI segmentation")
  }

  // The payload type forces senders to narrow, but the wire is a trust
  // boundary (a pre-update content script can send a translate-only ref).
  // Refuse before the cache reads: the ref could only throw deeper anyway,
  // after a doomed generation attempt.
  if (!canProviderRefGenerateText(providerRef)) {
    throw new Error(`Provider cannot generate text; AI segmentation needs a promptable model`)
  }

  const source = inputFragmentsSchema
    .parse(JSON.parse(jsonContent))
    .map(({ s, e, t }) => ({ start: s, end: e, text: t }))

  const { systemPrompt, prompt } = getSubtitlesSegmentationPrompt(jsonContent)
  const cacheKey = Sha256Hex(
    "subtitle-segmentation-v3:aligned:16384",
    systemPrompt,
    prompt,
    getProviderCacheIdentity(providerRef),
  )
  const cached = await db.aiSegmentationCache.get(cacheKey)
  options.signal?.throwIfAborted()
  if (cached) {
    if (isSegmentationAligned(source, parseSimplifiedVttToFragments(cached.result))) {
      logger.info("[Background] AI subtitle segmentation cache hit")
      return cached.result
    }
    // Old caches can contain parseable but shifted/missing cues too.
    await db.aiSegmentationCache.delete(cacheKey)
  }

  try {
    const segmentedVtt = await generateTextForProviderRef(
      {
        providerRef,
        // Its own route, not videoSubtitles: segmentation emits a whole WebVTT
        // block and needs the wider output budget that route reserves.

        instructions: systemPrompt,
        prompt,
        maxOutputTokens: 16_384,
      },
      options,
    )
    options.signal?.throwIfAborted()

    const result = cleanVttResponse(segmentedVtt)

    // Parse-check before caching: a cached result that yields no cues would be
    // served on every later attempt for this chunk, pinning the failure until
    // the provider's cache identity changes.
    const segmented = parseSimplifiedVttToFragments(result)
    if (segmented.length === 0) {
      throw new Error("AI segmentation returned an unparseable result")
    }
    if (!isSegmentationAligned(source, segmented)) {
      throw new Error("AI segmentation does not match the source timeline")
    }

    options.signal?.throwIfAborted()
    await db.aiSegmentationCache.put({
      key: cacheKey,
      result,
      createdAt: new Date(),
    })

    logger.info("[Background] AI subtitle segmentation completed")
    return result
  } catch (error) {
    logger.error("[Background] AI subtitle segmentation failed:")
    throw error
  }
}
