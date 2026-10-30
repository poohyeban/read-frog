import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { sendMessage } from "@/utils/message"
import {
  clearInMemoryTranslationCache,
  getInMemoryTranslation,
  storeInMemoryTranslation,
} from "../in-memory-translation-cache"
import { executeTranslationPlan } from "../translation-executor"
import {
  assertTranslationPlanIdentity,
  createTranslationPlan,
  type TranslationPlanInput,
} from "../translation-plan"
const messaging = vi.hoisted(() => ({ sendMessage: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/message", () => messaging)
function input(): TranslationPlanInput {
  return {
    origin: "page",
    mode: "bilingual",
    configRevision: 7,
    documentRevision: 3,
    text: "Original sentence",
    providerRef: { kind: "local", config: structuredClone(DEFAULT_CONFIG.providersConfig[0]!) },
    langConfig: structuredClone(DEFAULT_CONFIG.language),
    promptConfig: {
      customPromptsConfig: structuredClone(DEFAULT_CONFIG.pageTranslation.customPromptsConfig),
    },
    contextAware: true,
    context: { webTitle: "Title", webSummary: "Summary" },
    glossaryTerms: [],
    glossaryRevision: 2,
    textFormat: "plain",
    preserveLineBreaks: false,
    scope: { kind: "page", id: "scope-a" },
    forceRetranslation: false,
    extraHashTags: [],
  }
}
beforeEach(() => {
  clearInMemoryTranslationCache()
  vi.clearAllMocks()
})
describe("prepared plan execution contract", () => {
  it("owns an immutable snapshot and validates the exact transported identity", () => {
    const original = input()
    const plan = createTranslationPlan(original)
    original.providerRef.config.name = "Edited later"
    original.context!.webSummary = "Changed later"
    expect(plan.request.webSummary).toBe("Summary")
    expect(plan.request.providerRef.config.name).not.toBe("Edited later")
    expect(Object.isFrozen(plan.request.providerRef.config)).toBe(true)
    expect(plan.revisions).toMatchObject({ config: 7, document: 3 })
    expect(() => assertTranslationPlanIdentity({ ...plan.request, scheduleAt: 0 })).not.toThrow()
    expect(() =>
      assertTranslationPlanIdentity({
        ...plan.request,
        webSummary: "Different meaning",
        scheduleAt: 0,
      }),
    ).toThrow("identity")
    const other = input()
    other.scope.id = "unrelated-session"
    other.configRevision = 8
    expect(createTranslationPlan(other).request.hash).toBe(plan.request.hash)
    other.promptConfig.customPromptsConfig = {
      promptId: "new",
      patterns: [
        { id: "new", name: "New", systemPrompt: "Different instruction", prompt: "{{input}}" },
      ],
    }
    expect(createTranslationPlan(other).request.hash).not.toBe(plan.request.hash)
  })
  it("dispatches the plan verbatim and rejects invalid marker output before it enters memory", async () => {
    const original = input()
    original.textFormat = "html"
    original.text = '<a data-rf-attr="0">Link</a>'
    const plan = createTranslationPlan(original)
    vi.mocked(sendMessage).mockResolvedValue("Missing marker")
    await expect(executeTranslationPlan(plan, { isCurrent: () => true })).rejects.toMatchObject({
      code: "HTML_ATTR_MARKER_INTEGRITY",
    })
    expect(sendMessage).toHaveBeenCalledWith("enqueueTranslateRequest", {
      ...plan.request,
      scheduleAt: expect.any(Number),
    })
    expect(getInMemoryTranslation(plan.request.hash)).toBeUndefined()
  })
  it("checks validity before memory hits and never caches late cancelled network results", async () => {
    const plan = createTranslationPlan(input())
    storeInMemoryTranslation(plan.request.hash, "Cached result")
    await expect(executeTranslationPlan(plan, { isCurrent: () => false })).rejects.toMatchObject({
      name: "TranslationCancelledError",
    })
    expect(sendMessage).not.toHaveBeenCalled()
    clearInMemoryTranslationCache()
    let complete!: (value: string) => void
    messaging.sendMessage.mockImplementation((name) =>
      name === "enqueueTranslateRequest"
        ? new Promise<string>((resolve) => {
            complete = resolve
          })
        : Promise.resolve(),
    )
    const controller = new AbortController()
    const task = executeTranslationPlan(plan, {
      signal: controller.signal,
      isCurrent: () => true,
    }).catch((error) => error)
    controller.abort()
    expect(sendMessage).toHaveBeenLastCalledWith("cancelPageTranslationRequests", {
      sessionId: plan.scope.id,
    })
    expect(await task).toMatchObject({ name: "TranslationCancelledError" })
    complete("Late result")
    await Promise.resolve()
    expect(getInMemoryTranslation(plan.request.hash)).toBeUndefined()
  })
})
