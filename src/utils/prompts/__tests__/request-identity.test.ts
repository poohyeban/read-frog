import type { TranslationIdentityInput } from "../request-identity"
import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  assertTranslationRequestIdentity,
  getTranslationBatchIdentity,
  getTranslationRequestHash,
} from "../request-identity"
import { getSubtitlesTranslatePromptFromTemplate } from "../subtitles"
import { getTranslatePromptFromTemplate } from "../translate"

function request(kind: "page" | "subtitles" = "page"): TranslationIdentityInput {
  return {
    text: "hello",
    langConfig: DEFAULT_CONFIG.language,
    providerRef: { kind: "local", config: DEFAULT_CONFIG.providersConfig[0]! },
    snapshot: {
      version: 2,
      kind,
      template: { systemPrompt: "old instructions", prompt: "{{input}}" },
      glossaryEnabled: true,
      contentAware: true,
    },
    glossaryTerms: [],
    webTitle: "old title",
  }
}

describe("translation identity v2", () => {
  it.each(["page", "subtitles"] as const)(
    "validates %s snapshots and rejects legacy messages",
    (kind) => {
      const data = request(kind)
      const hash = getTranslationRequestHash(data)
      expect(hash).toMatch(/^translation:v2:[a-f0-9]{64}$/)
      expect(() => assertTranslationRequestIdentity({ ...data, hash }, kind)).not.toThrow()
      expect(() =>
        assertTranslationRequestIdentity({ ...data, hash, snapshot: undefined }, kind),
      ).toThrow(/stale/)
      expect(() =>
        assertTranslationRequestIdentity({ ...data, hash: "old-cache-key" }, kind),
      ).toThrow(/stale/)
    },
  )

  it.each(["text", "provider", "prompt", "language", "context", "policy", "terms"])(
    "rejects a changed %s under the original cache key",
    (change) => {
      const data = request()
      const hash = getTranslationRequestHash(data)
      const changed = structuredClone(data)
      if (change === "text") changed.text = "different"
      if (change === "provider") changed.providerRef.config.id = "different"
      if (change === "prompt") changed.snapshot!.template.systemPrompt = "new instructions"
      if (change === "language") changed.langConfig.targetCode = "fra"
      if (change === "context") changed.webTitle = "different"
      if (change === "policy") changed.snapshot!.glossaryEnabled = false
      if (change === "terms")
        changed.glossaryTerms = [
          { source: "hello", target: "bonjour", keepOriginal: false, matchKey: "hello" },
        ]
      expect(() => assertTranslationRequestIdentity({ ...changed, hash }, "page")).toThrow(
        /inconsistent/,
      )
    },
  )

  it("splits batches on same-ID provider edits, templates, and glossary policy, not individual matched terms", () => {
    const data = request()
    const batch = {
      provider: data.providerRef,
      langConfig: data.langConfig,
      snapshot: data.snapshot,
      glossaryRevision: 1,
    }
    const key = getTranslationBatchIdentity(batch)
    for (const edit of [
      { provider: { ...data.providerRef, config: { ...data.providerRef.config, name: "edited" } } },
      { snapshot: { ...data.snapshot!, template: { systemPrompt: "new", prompt: "new" } } },
      { snapshot: { ...data.snapshot!, glossaryEnabled: false } },
      { glossaryRevision: 2 },
    ])
      expect(getTranslationBatchIdentity({ ...batch, ...edit })).not.toBe(key)
    expect(
      getTranslationBatchIdentity({
        ...batch,
        snapshot: { ...data.snapshot!, cacheTags: ["different-item"] },
      }),
    ).toBe(key)
  })

  it.each([getTranslatePromptFromTemplate, getSubtitlesTranslatePromptFromTemplate])(
    "executes a captured template after edits without configuration access",
    (build) => {
      const data = request()
      const captured = structuredClone(data.snapshot!.template)
      data.snapshot!.template.systemPrompt = "new instructions"
      const first = build(captured, "Chinese", "hello", { isBatch: true, glossaryTerms: [] })
      const retry = build(captured, "Chinese", "hello", { isBatch: true, glossaryTerms: [] })
      expect(first.systemPrompt).toContain("old instructions")
      expect(first.systemPrompt).not.toContain("new instructions")
      expect(retry).toEqual(first)
    },
  )
})
