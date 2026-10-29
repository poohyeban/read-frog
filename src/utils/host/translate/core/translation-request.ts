import type { InlineAtomExtraction } from "../dom/inline-atoms"
import type { PageTranslationRequestOptions } from "../translate-variants"
import type { Config } from "@/types/config/config"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { TransNode } from "@/types/dom"
import { logger } from "@/utils/logger"
import { getOwnerDocument } from "../../dom/node"
import { extractInlineAtomText, getInlineAtomSelector } from "../dom/inline-atoms"
import { protectTranslationHtmlAttributes } from "../dom/translation-html-attributes"
import { shouldFilterSmallParagraph } from "../filter-small-paragraph"
import { isHtmlAttributeMarkerIntegrityError } from "../html-attribute-markers"
import { shouldSkipAsTargetLanguage } from "../target-language-skip"
import { normalizeForComparison } from "../text-preparation"
import { translateTextForPage } from "../translate-variants"
import { isNumericContent } from "../ui/translation-utils"

interface PageTranslationSource extends InlineAtomExtraction {
  nodes: readonly TransNode[]
}

interface PageTranslationRequest {
  sourceText: string
  textFormat: TranslationTextFormat
  translate: () => Promise<string>
  getDisplayText: (translatedText: string | undefined) => string | undefined
}

/** Both modes filter the same prose; code and formulas never affect eligibility. */
export function preparePageTranslationSource(
  nodes: readonly TransNode[],
  config: Config,
): PageTranslationSource | null {
  const extraction = extractInlineAtomText(nodes, config)
  const filterText = extraction.filterText.trim()
  if (!filterText || isNumericContent(filterText)) return null
  if (extraction.atoms.length > 0 && !extraction.hasProse) return null
  return { ...extraction, nodes, filterText, requestText: extraction.requestText.trim() }
}

/**
 * Run before either mode inserts its spinner; virtual paragraphs use this too.
 * Pass prose (`filterText`), never the HTML request: language detection on
 * markup is noise.
 */
export async function shouldSkipPageTranslationText(
  text: string,
  config: Config,
): Promise<boolean> {
  return (
    !text.trim() ||
    isNumericContent(text) ||
    (await shouldFilterSmallParagraph(text, config)) ||
    (await shouldSkipAsTargetLanguage(text, config))
  )
}

export function getDisplayTranslation(
  sourceText: string,
  translatedText: string | undefined,
  comparisonText: string | undefined = translatedText,
) {
  if (translatedText === undefined) {
    return undefined
  }

  // comparisonText lets the HTML-marker path (#1832) compare a normalized
  // variant while the raw translatedText is what gets displayed; the folding
  // normalization (#1835) applies on top for both paths.
  return normalizeForComparison(sourceText) === normalizeForComparison(comparisonText)
    ? ""
    : translatedText
}

/**
 * Shared request/response preparation, independent of how the result is displayed.
 * Plain requests keep Microsoft compatibility and clone atoms at token positions.
 * HTML requests retain the translation-only attribute/atom protection and fallback,
 * so the result can be aligned with the site's existing elements.
 */
export function createPageTranslationRequest(
  source: PageTranslationSource,
  config: Config,
  textFormat: TranslationTextFormat,
  options: PageTranslationRequestOptions,
): PageTranslationRequest {
  if (textFormat === "plain") {
    return {
      sourceText: source.requestText,
      textFormat,
      translate: () => translateTextForPage(source.requestText, textFormat, options),
      getDisplayText: (translatedText) => getDisplayTranslation(source.requestText, translatedText),
    }
  }

  const protectedHtml = protectTranslationHtmlAttributes(
    source.nodes,
    getOwnerDocument(source.nodes[0]!),
    getInlineAtomSelector(config),
  )
  // The source string mixes text nodes with element outerHTML and the result
  // is re-rendered via innerHTML, so providers must treat it as HTML to keep
  // its tags intact.

  const translateLegacyHtml = async () => {
    const translatedHtml = await translateTextForPage(
      protectedHtml.legacyRequestHtml,
      "html",
      options,
    )
    return translatedHtml ? protectedHtml.restoreLegacy(translatedHtml) : translatedHtml
  }
  const translateRequest = async () => {
    if (!protectedHtml.hasPlaceholders) return translateLegacyHtml()

    try {
      const translatedHtml = await translateTextForPage(protectedHtml.requestHtml, "html", options)
      if (!translatedHtml) {
        return translatedHtml
      }

      const restoredHtml = protectedHtml.restore(translatedHtml)

      return restoredHtml
    } catch (error) {
      if (!isHtmlAttributeMarkerIntegrityError(error)) {
        throw error
      }

      logger.warn("HTML attribute placeholders were not preserved; retrying full HTML", error)
      return translateLegacyHtml()
    }
  }

  return {
    sourceText: protectedHtml.sourceHtml,
    textFormat,
    translate: translateRequest,
    getDisplayText: (translatedText) =>
      translatedText
        ? getDisplayTranslation(
            protectedHtml.comparisonSourceHtml,
            translatedText,
            protectedHtml.normalizeForComparison(translatedText),
          )
        : translatedText,
  }
}
