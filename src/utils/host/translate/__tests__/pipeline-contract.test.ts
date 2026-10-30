// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { setupPageTranslationHandlers } from "@/entrypoints/background/page-translation"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  CONTENT_WRAPPER_CLASS,
  BLOCK_ATTRIBUTE,
  PARAGRAPH_ATTRIBUTE,
} from "@/utils/constants/dom-labels"
import { flushBatchedOperations } from "../../dom/batch-dom"
import { translateNodes } from "../core/translation-modes"
import { removeAllTranslatedWrapperNodes } from "../dom/translation-cleanup"
import { translationActivity } from "../engine-state"
import { clearInMemoryTranslationCache } from "../in-memory-translation-cache"
import { assertTranslationPlanIdentity } from "../translation-plan"
import { beginPageTranslationSession, endPageTranslationSession } from "../translation-session"
import { releaseWebPageContext } from "../webpage-context"
import { releaseWebPageSummaries } from "../webpage-summary"

const io = vi.hoisted(() => ({
  config: vi.fn<(...args: any[]) => any>(),
  provider: vi.fn<(...args: any[]) => any>(),
  summary: vi.fn<(...args: any[]) => any>(),
  read: vi.fn<(...args: any[]) => any>(),
  write: vi.fn<(...args: any[]) => any>(),
  handlers: new Map<string, (message: any) => Promise<any>>(),
  requests: [] as any[],
}))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: io.config }))
vi.mock("@/entrypoints/background/config", () => ({ ensureInitializedConfig: io.config }))
vi.mock("@/utils/host/translate/execute-translate", () => ({ executeTranslate: io.provider }))
vi.mock("@/utils/content/summary", async (original) => ({
  ...(await original<object>()),
  generateArticleSummary: io.summary,
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    translationCache: { get: io.read, put: io.write, delete: vi.fn<(...args: any[]) => any>() },
    articleSummaryCache: {
      get: vi.fn<(...args: any[]) => any>(),
      put: vi.fn<(...args: any[]) => any>(),
    },
  },
}))
vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: (message: any) => Promise<any>) =>
    io.handlers.set(name, handler),
  sendMessage: async (name: string, data: any) => {
    if (name === "enqueueTranslateRequest") {
      assertTranslationPlanIdentity(data)
      io.requests.push(data)
    }
    return io.handlers.get(name)?.({ data, sender: { tab: { id: 42 } } })
  },
}))
vi.mock("defuddle/full", () => ({
  default: class {
    parse() {
      return { content: "<p>Original article context.</p>" }
    }
  },
  createMarkdownContent: () => "Original article context.",
}))
beforeEach(() => {
  vi.clearAllMocks()
  io.requests.length = 0
  clearInMemoryTranslationCache()
  io.provider.mockResolvedValue("这是一段经过翻译的完整文本。")
  io.summary.mockResolvedValue("Article summary")
  io.read.mockResolvedValue(undefined)
  io.write.mockResolvedValue(undefined)
})
afterEach(() => {
  endPageTranslationSession()
  flushBatchedOperations()
  removeAllTranslatedWrapperNodes()
  releaseWebPageContext()
  releaseWebPageSummaries()
})
async function start(mode: "bilingual" | "translationOnly") {
  const config = structuredClone(DEFAULT_CONFIG)
  config.pageTranslation.mode = mode
  config.pageTranslation.enableAIContentAware = true
  config.language.sourceCode = "eng"
  config.language.targetCode = "cmn"
  io.config.mockResolvedValue(config)
  setupPageTranslationHandlers()
  document.title = "An article about translation"
  document.body.innerHTML =
    "<main><p>This original English paragraph describes the complete lifecycle of a translation request in an article.</p></main>"
  const source = document.querySelector("p")!
  source.setAttribute(BLOCK_ATTRIBUTE, "")
  source.setAttribute(PARAGRAPH_ATTRIBUTE, "")
  beginPageTranslationSession(config)
  return { source, config }
}
it.each(["bilingual", "translationOnly"] as const)(
  "runs context → immutable plan → real queues → provider → %s commit and restores source",
  async (mode) => {
    const { source, config } = await start(mode)
    const original = source.textContent
    const originalNode = source.firstChild
    await translateNodes([source], "pipeline", false, config)
    flushBatchedOperations()
    expect(io.summary).toHaveBeenCalledTimes(1)
    expect(io.provider).toHaveBeenCalledTimes(1)
    expect(io.requests[0]).toMatchObject({
      webSummary: "Article summary",
      planIdentity: { version: 1 },
    })
    expect(io.provider.mock.calls[0]![2]).toEqual(io.requests[0].providerRef.config)
    expect(source.textContent).toContain("这是一段")
    expect(translationActivity.getSnapshot()).toMatchObject({
      phase: "settled",
      completedRequests: 1,
      committedResults: 1,
      pending: { context: 0, request: 0, render: 0 },
    })
    removeAllTranslatedWrapperNodes()
    expect(source.textContent).toBe(original)
    expect(source.firstChild).toBe(originalNode)
  },
)
it("rejects a late provider response after the host replaces the source", async () => {
  const { source, config } = await start("bilingual")
  let complete!: (text: string) => void
  io.provider.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve
      }),
  )
  const task = translateNodes([source], "stale-pipeline", false, config)
  await vi.waitFor(() => expect(io.provider).toHaveBeenCalledOnce())
  source.firstChild!.textContent = "New host content"
  complete("过期译文")
  await task
  flushBatchedOperations()
  expect(source.textContent).toBe("New host content")
  expect(source.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
})
