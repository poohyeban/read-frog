import type { Config } from "@/types/config/config"
import type { LangCodeISO6393 } from "@/utils/languages"
import { getDetectedCodeFromStorage, getFinalSourceCode } from "@/utils/config/languages"
import { ISO6393_TO_6391 } from "@/utils/languages"
import { getEffectiveSiteRule } from "@/utils/site-rules/effective"

const segmenters = new Map<string, Intl.Segmenter>()

const PURE_HANDLE_RE = /^@\S+$/u

function countWords(text: string, sourceCode: LangCodeISO6393): number {
  // Convert ISO 639-3 (e.g., 'eng') to ISO 639-1 (e.g., 'en') for Intl.Segmenter
  const locale = ISO6393_TO_6391[sourceCode] ?? "en"
  let segmenter = segmenters.get(locale)
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: "word" })
    segmenters.set(locale, segmenter)
    if (segmenters.size > 16) segmenters.delete(segmenters.keys().next().value!)
  }
  let count = 0
  for (const segment of segmenter.segment(text)) if (segment.isWordLike) count++
  return count
}

async function getSourceCode(configSourceCode: LangCodeISO6393 | "auto"): Promise<LangCodeISO6393> {
  const detectedCode = await getDetectedCodeFromStorage()
  return getFinalSourceCode(configSourceCode, detectedCode)
}

export async function shouldFilterSmallParagraph(text: string, config: Config): Promise<boolean> {
  if (PURE_HANDLE_RE.test(text.trim())) return true

  const siteRule = getEffectiveSiteRule(config, window.location.href)
  const minCharactersPerNode =
    siteRule.minCharacters ?? config.pageTranslation.page.minCharactersPerNode
  const minWordsPerNode = siteRule.minWords ?? config.pageTranslation.page.minWordsPerNode
  const { sourceCode } = config.language

  if (minCharactersPerNode > 0 && text.length < minCharactersPerNode) return true

  if (minWordsPerNode > 0) {
    const finalSourceCode = await getSourceCode(sourceCode)
    if (countWords(text, finalSourceCode) < minWordsPerNode) return true
  }

  return false
}
