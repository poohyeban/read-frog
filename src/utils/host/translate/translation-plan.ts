import type { Config } from "@/types/config/config"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { WebPagePromptContext } from "@/types/content"
import type { TranslationRequestPayload } from "@/types/translation-request"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { LangCodeISO6393 } from "@/utils/languages"
import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import { Sha256Hex } from "@/utils/hash"
import { freezeData } from "@/utils/immutable"
import { LANG_CODE_TO_EN_NAME } from "@/utils/languages"
import { normalizePromptContextValue } from "@/utils/prompts/context"
import {
  getTranslatePromptFromConfig,
  getContextRequirements,
  type ContextRequirements,
} from "@/utils/prompts/translation-template"
import { hasHtmlAttributeMarkerProtocol } from "./html-attribute-markers"
import { hasInlineAtomTokens } from "./inline-atom-tokens"
import { prepareTranslationText } from "./text-preparation"

export { normalizePromptContextValue } from "@/utils/prompts/context"

export function normalizeWebPagePromptContext(
  webPageContext?: WebPagePromptContext,
): WebPagePromptContext | undefined {
  if (!webPageContext) {
    return undefined
  }

  return {
    webTitle: normalizePromptContextValue(webPageContext.webTitle),
    webDescription: normalizePromptContextValue(webPageContext.webDescription),
    webContent: normalizePromptContextValue(webPageContext.webContent),
    webSummary: normalizePromptContextValue(webPageContext.webSummary),
  }
}

export function buildWebPageHashComponents(
  text: string,
  providerRef: SerializableProviderRef,
  partialLangConfig: { sourceCode: LangCodeISO6393 | "auto"; targetCode: LangCodeISO6393 },
  enableAIContentAware: boolean,
  textFormat: TranslationTextFormat,
  preserveLineBreaks: boolean,
  glossaryTerms: readonly MatchedTerm[],
  webPageContext: WebPagePromptContext | undefined,
  promptConfig: Pick<Config["pageTranslation"], "customPromptsConfig">,
): string[] {
  const preparedText = prepareTranslationText(text)
  const normalizedWebPageContext = normalizeWebPagePromptContext(webPageContext)

  const providerHashIdentity = providerRef.config
  const hashComponents = [
    preparedText,
    JSON.stringify(providerHashIdentity),
    partialLangConfig.sourceCode,
    partialLangConfig.targetCode,
  ]

  const targetLangName = LANG_CODE_TO_EN_NAME[partialLangConfig.targetCode]
  // The terms are passed in rather than resolved here, so the prompt this hash
  // is taken over is built from exactly the terms the request will carry.
  const promptOptions = { isBatch: true, context: normalizedWebPageContext, glossaryTerms }
  const { systemPrompt, prompt } = getTranslatePromptFromConfig(
    promptConfig,
    targetLangName,
    preparedText,
    promptOptions,
  )
  hashComponents.push(
    systemPrompt,
    prompt,
    `format:${textFormat}`,
    `lineBreaks:${preserveLineBreaks}`,
  )
  hashComponents.push(
    enableAIContentAware ? "enableAIContentAware=true" : "enableAIContentAware=false",
  )

  if (enableAIContentAware && normalizedWebPageContext) {
    if (normalizedWebPageContext.webTitle) {
      hashComponents.push(`webTitle:${normalizedWebPageContext.webTitle}`)
    }
    if (normalizedWebPageContext.webDescription) {
      hashComponents.push(`webDescription:${normalizedWebPageContext.webDescription}`)
    }
    if (normalizedWebPageContext.webContent) {
      hashComponents.push(`webContent:${normalizedWebPageContext.webContent}`)
    }
    if (normalizedWebPageContext.webSummary) {
      hashComponents.push(`webSummary:${normalizedWebPageContext.webSummary}`)
    }
  }

  return hashComponents
}

export type TranslationOrigin = "page" | "page-title" | "input" | "selection" | "independent"
export interface TranslationPlanInput {
  origin: TranslationOrigin
  mode: Config["pageTranslation"]["mode"] | "independent"
  configRevision: number
  documentRevision: number
  text: string
  providerRef: SerializableProviderRef
  langConfig: Config["language"]
  promptConfig: Pick<Config["pageTranslation"], "customPromptsConfig">
  context?: WebPagePromptContext
  contextAware: boolean
  glossaryTerms: MatchedTerm[]
  glossaryRevision: number
  textFormat: TranslationTextFormat
  preserveLineBreaks: boolean
  scope: { kind: "page" | "independent"; id: string }
  forceRetranslation: boolean
  extraHashTags: string[]
}
export interface TranslationPlan {
  readonly origin: TranslationOrigin
  readonly mode: TranslationPlanInput["mode"]
  readonly revisions: {
    readonly config: number
    readonly document: number
    readonly source: string
  }
  readonly requirements: Readonly<ContextRequirements>
  readonly scope: Readonly<TranslationPlanInput["scope"]>
  readonly request: Readonly<Omit<TranslationRequestPayload, "scheduleAt">>
  readonly validation: { readonly htmlAttributes: boolean; readonly inlineAtoms: boolean }
}
/** Pure planning: all asynchronous dependencies are resolved by the caller. */
export function createTranslationPlan(input: TranslationPlanInput): TranslationPlan {
  const data = structuredClone(input)
  const text = prepareTranslationText(data.text)
  const context = normalizeWebPagePromptContext(data.context)
  const hash = Sha256Hex(
    ...buildWebPageHashComponents(
      text,
      data.providerRef,
      data.langConfig,
      data.contextAware,
      data.textFormat,
      data.preserveLineBreaks,
      data.glossaryTerms,
      context,
      data.promptConfig,
    ),
    ...data.extraHashTags,
  )
  return freezeData({
    origin: data.origin,
    mode: data.mode,
    revisions: {
      config: data.configRevision,
      document: data.documentRevision,
      source: Sha256Hex(text),
    },
    requirements: getContextRequirements(data.promptConfig),
    scope: data.scope,
    validation: {
      htmlAttributes: data.textFormat === "html" && hasHtmlAttributeMarkerProtocol(text),
      inlineAtoms: hasInlineAtomTokens(text),
    },
    request: {
      text,
      providerRef: data.providerRef,
      langConfig: data.langConfig,
      promptConfig: data.promptConfig,
      hash,
      textFormat: data.textFormat,
      preserveLineBreaks: data.preserveLineBreaks,
      webTitle: context?.webTitle,
      webDescription: context?.webDescription,
      webContent: context?.webContent,
      webSummary: context?.webSummary,
      glossaryTerms: data.glossaryTerms,
      glossaryRevision: data.glossaryRevision,
      sessionId: data.scope.id,
      forceRetranslation: data.forceRetranslation,
      planIdentity: {
        version: 1 as const,
        contextAware: data.contextAware,
        extraHashTags: data.extraHashTags,
      },
    },
  })
}

/** Wire boundary: reject mismatched cache identities before cache access or execution. */
export function assertTranslationPlanIdentity(request: TranslationRequestPayload): void {
  if (!request.planIdentity) return // Compatibility with already loaded old content scripts.
  if (request.planIdentity.version !== 1 || !request.promptConfig || !request.glossaryTerms)
    throw new Error("Incomplete translation plan")
  const identity = Sha256Hex(
    ...buildWebPageHashComponents(
      request.text,
      request.providerRef,
      request.langConfig,
      request.planIdentity.contextAware,
      request.textFormat ?? "plain",
      request.preserveLineBreaks ?? false,
      request.glossaryTerms,
      {
        webTitle: request.webTitle,
        webDescription: request.webDescription,
        webContent: request.webContent,
        webSummary: request.webSummary,
      },
      request.promptConfig,
    ),
    ...request.planIdentity.extraHashTags,
  )
  if (identity !== request.hash)
    throw new Error("Translation plan identity does not match its request snapshot")
}
