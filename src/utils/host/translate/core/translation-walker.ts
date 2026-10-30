import type { Config } from "@/types/config/config"
import {
  BLOCK_ATTRIBUTE,
  CONTENT_WRAPPER_CLASS,
  PARAGRAPH_ATTRIBUTE,
  TRANSLATION_ONLY_ATTRIBUTE,
  WALKED_ATTRIBUTE,
} from "../../../constants/dom-labels"
import {
  isBlockTransNode,
  isHTMLElement,
  isNaturalBlockTransNode,
  isSiteRuleForceBlockStyleElement,
  isTextNode,
  isTransNode,
} from "../../dom/filter"
import { pageLocalScheduler } from "../local-scheduler"
import { translateNodes } from "./translation-modes"
import { getTranslationOnlyAnchorState } from "./translation-state"

/**
 * Marker attributes can outlive their WeakMap state (extension reload on a
 * live tab). A ghost marker must not block walks forever — heal it and treat
 * the region as untranslated.
 */
function hasLiveTranslationOnlyAnchor(element: HTMLElement): boolean {
  const candidates: HTMLElement[] = element.hasAttribute(TRANSLATION_ONLY_ATTRIBUTE)
    ? [element]
    : []
  candidates.push(...element.querySelectorAll<HTMLElement>(`[${TRANSLATION_ONLY_ATTRIBUTE}]`))
  let live = false
  for (const candidate of candidates) {
    if (getTranslationOnlyAnchorState(candidate)) live = true
    else candidate.removeAttribute(TRANSLATION_ONLY_ATTRIBUTE)
  }
  return live
}

export async function translateWalkedElement(
  root: HTMLElement,
  walkId: string,
  config: Config,
  toggle: boolean = false,
  // Liveness gate re-checked after every yield. Because pacing spreads a giant
  // subtree's expansion across seconds, a session cancelled mid-expansion must
  // stop here — the WALKED attribute alone does not (stop() never strips it),
  // so without this the walk keeps inserting wrappers/spinners into the page
  // the user just cleared (#1881).
  shouldContinue: () => boolean = () => true,
  forceRetranslation: boolean = false,
): Promise<void> {
  const promises: Promise<void>[] = []
  function* expand(element: HTMLElement): Generator<void> {
    yield
    if (!shouldContinue()) return
    // Translated regions are skipped on non-toggle walks. In-place-swapped
    // paragraphs leave no wrapper, so also check the anchor marker attribute.
    if (
      !toggle &&
      (element.querySelector(`.${CONTENT_WRAPPER_CLASS}`) || hasLiveTranslationOnlyAnchor(element))
    ) {
      return
    }

    // if the walkId is not the same, return
    if (element.getAttribute(WALKED_ATTRIBUTE) !== walkId) return

    if (element.hasAttribute(PARAGRAPH_ATTRIBUTE)) {
      let hasBlockNodeChild = false
      let hasBlockLayoutChild = false

      for (const child of element.childNodes) {
        if (isHTMLElement(child)) {
          if (child.hasAttribute(BLOCK_ATTRIBUTE)) {
            hasBlockNodeChild = true
          }
          if (
            isNaturalBlockTransNode(child) ||
            (child.hasAttribute(BLOCK_ATTRIBUTE) && isSiteRuleForceBlockStyleElement(child, config))
          ) {
            hasBlockLayoutChild = true
          }
        }
      }

      const computedStyle = window.getComputedStyle(element)
      const isFlexParent = computedStyle.display.includes("flex")

      if (!hasBlockNodeChild) {
        promises.push(translateNodes([element], walkId, toggle, config, false, forceRetranslation))
      } else {
        // prevent children change during iteration
        const children = [...element.childNodes]
        let consecutiveInlineNodes: ChildNode[] = []
        for (const child of children) {
          yield
          if (!shouldContinue()) return
          if (isTransNode(child) && isBlockTransNode(child) && !isTextNode(child)) {
            // A Node-only forced block may split the translation run without
            // changing wrapper layout. Natural block children and the combined
            // Node+Style shape produced by legacy force-block migration retain
            // the old group-level block wrapper hint.
            promises.push(
              translateNodes(
                consecutiveInlineNodes,
                walkId,
                toggle,
                config,
                !isFlexParent && hasBlockLayoutChild,
                forceRetranslation,
              ),
            )
            consecutiveInlineNodes = []
            yield* expand(child)
          } else {
            consecutiveInlineNodes.push(child)
          }
        }

        if (consecutiveInlineNodes.length) {
          promises.push(
            translateNodes(
              consecutiveInlineNodes,
              walkId,
              toggle,
              config,
              !isFlexParent && hasBlockLayoutChild,
              forceRetranslation,
            ),
          )
        }
      }
    } else {
      for (const child of element.childNodes) {
        if (isHTMLElement(child)) {
          yield* expand(child)
        }
      }
      if (element.shadowRoot) {
        for (const child of element.shadowRoot.children) {
          if (isHTMLElement(child)) {
            yield* expand(child)
          }
        }
      }
    }
  }
  await pageLocalScheduler.run(expand(root), { current: shouldContinue, foreground: true })
  // This simultaneously ensures that when concurrent translation
  // and external await call this function, all translations are completed
  await Promise.all(promises)
}
