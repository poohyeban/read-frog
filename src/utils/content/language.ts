import type { LangCodeISO6393 } from "@/utils/languages"
import { franc } from "franc"
import { langCodeISO6393Schema } from "@/utils/languages"

const DEFAULT_MIN_LENGTH = 10
const detections = new Map<string, DetectLanguageResult>()

export type DetectionSource = "franc" | "fallback"

export interface DetectLanguageOptions {
  minLength?: number
}

export interface DetectLanguageResult {
  code: LangCodeISO6393 | "und"
  source: DetectionSource
}

/**
 * Detect language of text locally using franc.
 * Returns both the detected code and the detection source.
 * @param text - Text to detect language for
 * @param options - Detection options
 * @returns Detection result with code and source
 */
export async function detectLanguageWithSource(
  text: string,
  options?: DetectLanguageOptions,
): Promise<DetectLanguageResult> {
  const trimmedText = text.trim()
  const minLength = options?.minLength ?? DEFAULT_MIN_LENGTH

  if (trimmedText.length < minLength) {
    return { code: "und", source: "fallback" }
  }

  const cached = detections.get(trimmedText)
  if (cached) {
    detections.delete(trimmedText)
    detections.set(trimmedText, cached)
    return { ...cached }
  }
  const francResult = franc(trimmedText)
  if (francResult === "und") {
    return { code: "und", source: "fallback" }
  }

  const parsedFrancResult = langCodeISO6393Schema.safeParse(francResult)
  if (!parsedFrancResult.success) {
    return { code: "und", source: "fallback" }
  }

  const result: DetectLanguageResult = { code: parsedFrancResult.data, source: "franc" }
  if (trimmedText.length <= 8192) {
    detections.set(trimmedText, result)
    if (detections.size > 256) detections.delete(detections.keys().next().value!)
  }
  return { ...result }
}

/**
 * Detect language of text locally using franc.
 * @param text - Text to detect language for
 * @param options - Detection options
 * @returns Detected language code or null if detection failed
 */
export async function detectLanguage(
  text: string,
  options?: DetectLanguageOptions,
): Promise<LangCodeISO6393 | null> {
  const result = await detectLanguageWithSource(text, options)
  return result.code === "und" ? null : result.code
}

/**
 * Detect language using LLM with retry logic
 * @param text - Text to analyze (caller is responsible for combining title and content)
 * @param providerRef - Optional provider ref (resolved from global config when omitted)
 * @returns ISO 639-3 language code or null if all attempts fail (null = no LLM provider or all attempts failed)
 */
