import type { Config } from "@/types/config/config"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { getEffectiveSiteRule } from "@/utils/site-rules/effective"
import { isHTMLElement } from "../dom/filter"
import { walkAndLabelElement } from "../dom/traversal"
import { beginNodeTranslation } from "./core/node-translation-lifecycle"
import { translateWalkedElement } from "./core/translation-walker"
import { beginNodeSiteRuleCSSOperation } from "./ui/node-site-rule-css"
import { validateTranslationConfigAndToast } from "./ui/translation-config-feedback"

// Re-export public APIs
export {
  translateNodes,
  translateNodesBilingualMode,
  translateNodeTranslationOnlyMode,
} from "./core/translation-modes"
export { translateWalkedElement } from "./core/translation-walker"
export { removeAllTranslatedWrapperNodes } from "./dom/translation-cleanup"

// High-level orchestration function
export async function removeOrShowNodeTranslation(node: Element, config: Config): Promise<boolean> {
  if (!isHTMLElement(node)) return false

  const id = getRandomUUID()

  if (
    !validateTranslationConfigAndToast({
      providersConfig: config.providersConfig,
      pageTranslation: config.pageTranslation,
      language: config.language,
    })
  ) {
    return false
  }

  const rootNode = node.getRootNode()
  const styleRoot = rootNode instanceof ShadowRoot ? rootNode : document
  const siteRule = getEffectiveSiteRule(config, window.location.href)
  const lifecycle = beginNodeTranslation(node, id)
  try {
    const releaseSiteRuleCSS = await beginNodeSiteRuleCSSOperation(styleRoot, siteRule.injectedCss)
    try {
      if (!lifecycle.isActive()) return false
      walkAndLabelElement(node, id, config)
      await translateWalkedElement(
        node,
        id,
        config,
        true,
        lifecycle.isActive,
        config.pageTranslation.node.forceRetranslation,
      )
    } finally {
      await releaseSiteRuleCSS()
    }
  } finally {
    lifecycle.finish()
  }
  return true
}
