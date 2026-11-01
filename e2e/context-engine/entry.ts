import { storage } from "#imports"
import { PageTranslationManager } from "@/entrypoints/content-runtime/host/translation-control/page-translation"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG, CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { BLOCK_ATTRIBUTE, PARAGRAPH_ATTRIBUTE } from "@/utils/constants/dom-labels"
import { walkAndLabelElement } from "@/utils/host/dom/traversal"
import {
  beginNodeTranslation,
  cleanupNodeTranslations,
} from "@/utils/host/translate/core/node-translation-lifecycle"
import { translateNodes } from "@/utils/host/translate/core/translation-modes"
import { translateWalkedElement } from "@/utils/host/translate/core/translation-walker"
import { removeAllTranslatedWrapperNodes } from "@/utils/host/translate/dom/translation-cleanup"
import { removeOrShowNodeTranslation } from "@/utils/host/translate/node-manipulation"
import {
  beginPageTranslationSession,
  endPageTranslationSession,
} from "@/utils/host/translate/translation-session"
import * as context from "@/utils/host/translate/webpage-context"
import { metrics, resetMessages } from "./messages"
import "@/assets/styles/translation-node-preset.css"

const config = structuredClone(DEFAULT_CONFIG)
config.providersConfig.find(
  (provider) => provider.id === config.pageTranslation.providerId,
)!.apiKey = "local-fixture"
config.language.sourceCode = "eng"
config.language.targetCode = "cmn"
config.glossary.enabled = false
config.pageTranslation.page.translateTitle = false
config.pageTranslation.enableAIContentAware = true
const manager = new PageTranslationManager()
async function reset(mode: "bilingual" | "translationOnly") {
  if (manager.isActive) manager.stop()
  endPageTranslationSession()
  cleanupNodeTranslations()
  removeAllTranslatedWrapperNodes()
  context.releaseWebPageContext()
  resetMessages()
  config.pageTranslation.mode = mode
  await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, config)
}
async function fixture(
  mode: "bilingual" | "translationOnly",
  units: number,
  manual: boolean,
  giant = false,
) {
  await reset(mode)
  document.body.innerHTML =
    '<main><article><h2>Article A</h2><div id="a"></div></article><article id="b"><h2>Article B</h2><p>Unrelated source</p></article></main>'
  const source = document.querySelector<HTMLElement>("#a")!
  if (giant) {
    source.style.height = "15000px"
    source.innerHTML = Array.from(
      { length: units },
      (_, index) =>
        `<p style="height:1500px">Original English source paragraph ${index} describes a separate part of a giant article.</p>`,
    ).join("")
  } else {
    source.style.whiteSpace = "pre-wrap"
    source.textContent = Array.from(
      { length: units },
      (_, index) => `Original English source paragraph ${index} describes its separate context.`,
    ).join("\n\n")
  }
  for (const paragraph of source.querySelectorAll("p")) {
    paragraph.setAttribute(BLOCK_ATTRIBUTE, "")
    paragraph.setAttribute(PARAGRAPH_ATTRIBUTE, "")
  }
  source.setAttribute(BLOCK_ATTRIBUTE, "")
  source.setAttribute(PARAGRAPH_ATTRIBUTE, "")
  beginPageTranslationSession(config)
  const lifecycle = manual ? beginNodeTranslation(source, "browser-manual") : undefined
  if (giant) walkAndLabelElement(source, "browser-page", config)
  const task = (
    giant
      ? translateWalkedElement(source, "browser-page", config)
      : translateNodes([source], manual ? "browser-manual" : "browser-page", false, config)
  ).finally(() => lifecycle?.finish())
  return { source, task }
}
Object.assign(window, {
  contextBrowser: {
    config,
    manager,
    context,
    metrics,
    reset,
    fixture,
    manual: async (source: HTMLElement) =>
      removeOrShowNodeTranslation(source, (await getLocalConfig())!),
    cleanup: () => {
      endPageTranslationSession()
      cleanupNodeTranslations()
      removeAllTranslatedWrapperNodes()
      context.releaseWebPageContext()
    },
  },
})
