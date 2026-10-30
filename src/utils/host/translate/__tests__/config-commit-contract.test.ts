// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { getLocalConfig, setLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  BLOCK_ATTRIBUTE,
  PARAGRAPH_ATTRIBUTE,
  CONTENT_WRAPPER_CLASS,
} from "@/utils/constants/dom-labels"
import { flushBatchedOperations } from "../../dom/batch-dom"
import { captureCommitGate } from "../commit-gate"
import { translateNodes } from "../core/translation-modes"
import { removeAllTranslatedWrapperNodes } from "../dom/translation-cleanup"
import { beginPageTranslationSession, endPageTranslationSession } from "../translation-session"
const translated = vi.hoisted(() => vi.fn<(...args: any[]) => any>())
vi.mock("../translate-variants", () => ({ translateTextForPage: translated }))
afterEach(() => {
  endPageTranslationSession()
  flushBatchedOperations()
  removeAllTranslatedWrapperNodes()
})
it.each(["bilingual", "translationOnly"] as const)(
  "rejects an old %s result after a real config write without invalidating body work for the title switch",
  async (mode) => {
    const settings = structuredClone(DEFAULT_CONFIG)
    settings.language.sourceCode = "eng"
    settings.language.targetCode = "cmn"
    settings.pageTranslation.mode = mode
    await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, settings)
    const config = (await getLocalConfig())!
    document.body.innerHTML =
      "<p>This English paragraph provides enough text for a translation request.</p>"
    const source = document.querySelector("p")!
    source.setAttribute(BLOCK_ATTRIBUTE, "")
    source.setAttribute(PARAGRAPH_ATTRIBUTE, "")
    beginPageTranslationSession(config)
    const gate = captureCommitGate(undefined, config)
    let resolve!: (text: string) => void
    translated.mockReset().mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done
        }),
    )
    const pending = translateNodes([source], "config-pending", false, config)
    await vi.waitFor(() => expect(translated).toHaveBeenCalledOnce())
    settings.pageTranslation.page.translateTitle = !settings.pageTranslation.page.translateTitle
    await setLocalConfig(settings)
    expect(gate.isCurrent()).toBe(true)
    settings.language.targetCode = "fra"
    await setLocalConfig(settings)
    expect(gate.isCurrent()).toBe(false)
    resolve("Old target language output")
    await pending
    flushBatchedOperations()
    expect(source.textContent).not.toContain("Old target")
    expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
    const updated = (await getLocalConfig())!
    const updatedGate = captureCommitGate(undefined, updated)
    expect(updatedGate.isCurrent()).toBe(true)
    await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, { pageTranslation: {}, language: {} })
    await vi.waitFor(() => expect(updatedGate.isCurrent()).toBe(false))
    expect(await getLocalConfig()).toEqual(DEFAULT_CONFIG)
  },
)
