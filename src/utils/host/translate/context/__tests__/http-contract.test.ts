// @vitest-environment jsdom
import { writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { TextEncoder as NativeTextEncoder } from "node:util"
import { expect, it, vi } from "vitest"
import { browser } from "#imports"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { BLOCK_ATTRIBUTE, PARAGRAPH_ATTRIBUTE } from "@/utils/constants/dom-labels"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"

const io = vi.hoisted(() => ({
  config: null as any,
  storage: new Map<string, any>(),
  cache: new Map<string, any>(),
  summaries: new Map<string, any>(),
  handlers: new Map<string, (value: any) => any>(),
  cacheHits: 0,
  summaryRPCs: 0,
}))
vi.mock("@/utils/config/init", () => ({
  ensureConfigInitialized: async () => ({ isFreshInstall: false }),
}))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: async () => io.config }))
vi.mock("@/entrypoints/background/config", () => ({
  ensureInitializedConfig: async () => io.config,
}))
vi.mock("wxt/utils/storage", () => ({
  storage: {
    getItem: async (key: string) => structuredClone(io.storage.get(key) ?? null),
    setItem: async (key: string, value: any) => {
      io.storage.set(key, structuredClone(value))
    },
    setItems: async (items: any[]) => {
      for (const item of items) io.storage.set(item.key, structuredClone(item.value))
    },
    watch: () => () => {},
  },
}))
vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: (value: any) => any) => io.handlers.set(name, handler),
  sendMessage: async (name: string, data: any) => {
    if (name === "getOrGenerateWebPageSummary") io.summaryRPCs++
    return io.handlers.get(name)?.({ data: structuredClone(data), sender: { tab: { id: 7 } } })
  },
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    translationCache: {
      get: async (key: string) => {
        const value = io.cache.get(key)
        if (value) io.cacheHits++
        return value
      },
      put: async (row: any) => {
        io.cache.set(row.key, structuredClone(row))
      },
      delete: async (key: string) => {
        io.cache.delete(key)
      },
    },
    articleSummaryCache: {
      get: async (key: string) => io.summaries.get(key),
      put: async (row: any) => {
        io.summaries.set(row.key, structuredClone(row))
      },
    },
  },
}))

it("verifies physical HTTP, scoped prompts, shared cancellation and cache reuse through the real SDK/queues", async () => {
  vi.stubGlobal("TextEncoder", NativeTextEncoder)
  const requests: { kind: string; members: string[]; status: number; at: number }[] = []
  let releaseResponse: (() => void) | undefined
  let holdNext = false
  let fail429 = false
  let lastPrompt = ""
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const source = body.messages
      .filter((message: any) => message.role === "user")
      .map((message: any) => message.content)
      .join("\n")
    const summary = JSON.stringify(body.messages).includes("Summarize the following article")
    const members = [...new Set<string>(source.match(/V2_SOURCE_[A-Z0-9]+/g) ?? [])]
    lastPrompt = JSON.stringify(body.messages)
    requests.push({
      kind: summary ? "summary" : "translation",
      members,
      status: fail429 ? 429 : 200,
      at: Date.now(),
    })
    if (fail429) {
      fail429 = false
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0.01" })
      res.end('{"error":{"message":"local cooldown"}}')
      return
    }
    if (holdNext) {
      holdNext = false
      await new Promise<void>((resolve) => {
        releaseResponse = resolve
      })
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: "local",
        object: "chat.completion",
        created: 1,
        model: "mock",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: summary
                ? "Local model summary."
                : members.map((member) => `译文 ${member}`).join("\n%%\n"),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const nativeFetch = globalThis.fetch
  vi.stubGlobal("fetch", ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) throw new Error("Non-local HTTP refused")
    return nativeFetch(input, {
      ...init,
      body: typeof init?.body === "string" ? Buffer.from(init.body, "utf8") : init?.body,
    })
  }) satisfies typeof fetch)
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [
    {
      ...DEFAULT_PROVIDER_CONFIG["openai-compatible"],
      id: "v2-local",
      name: "Local mock",
      enabled: true,
      apiKey: "local-only",
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: { model: "use-custom-model", isCustomModel: true, customModel: "mock" },
    },
  ]
  config.pageTranslation.providerId = "v2-local"
  config.pageTranslation.enableAIContentAware = true
  config.language.sourceCode = "eng"
  config.language.targetCode = "cmn"
  config.glossary.enabled = false
  io.config = config
  browser.tabs.onRemoved.addListener = vi.fn<() => void>()
  const { setupPageTranslationHandlers } = await import("@/entrypoints/background/page-translation")
  const { translateNodes } = await import("../../core/translation-modes")
  const { translateTextForPage } = await import("../../translate-variants")
  const { createTranslationTaskOwner } = await import("../task-owner")
  const { removeAllTranslatedWrapperNodes } = await import("../../dom/translation-cleanup")
  const { beginPageTranslationSession, endPageTranslationSession } =
    await import("../../translation-session")
  const { releaseWebPageContext, getContextDiagnostics } = await import("../../webpage-context")
  const { releaseWebPageSummaries } = await import("../../webpage-summary")
  const { clearInMemoryTranslationCache } = await import("../../in-memory-translation-cache")
  const { flushBatchedOperations } = await import("@/utils/host/dom/batch-dom")
  const { providerResourceScheduler } = await import("@/utils/providers/resource-runtime")
  setupPageTranslationHandlers()
  const metrics: Record<string, unknown> = {}
  const original =
    "V2_SOURCE_A describes the original English source and its local meaning in this post."
  try {
    document.body.innerHTML = `<main role="feed"><article><h2>Topic A</h2><p>${original}</p></article><article id="b"><h2>Unrelated B</h2><p>PRIVATE_B_CONTEXT</p></article></main>`
    const source = document.querySelector<HTMLElement>("p")!
    source.setAttribute(BLOCK_ATTRIBUTE, "")
    source.setAttribute(PARAGRAPH_ATTRIBUTE, "")
    beginPageTranslationSession(config)
    holdNext = true
    const started = performance.now()
    const pending = translateNodes([source], "http-page", false, config)
    await vi.waitFor(() => expect(releaseResponse).toBeTypeOf("function"))
    expect(lastPrompt).not.toContain("PRIVATE_B_CONTEXT")
    document.querySelector("#b")!.remove()
    releaseResponse!()
    await pending
    flushBatchedOperations()
    expect(source.textContent).toContain("译文 V2_SOURCE_A")
    expect(requests).toHaveLength(1)
    expect(io.summaryRPCs).toBe(0)
    metrics.unrelatedRemoval = {
      http: requests.length,
      firstTranslationMs: performance.now() - started,
    }
    removeAllTranslatedWrapperNodes()
    expect(source.textContent).toBe(original)
    clearInMemoryTranslationCache()
    const cached = await translateTextForPage(original, "plain", { source, config })
    expect(cached).toContain("译文")
    expect(requests).toHaveLength(1)
    expect(io.cacheHits).toBe(1)
    metrics.cache = { http: 0, hits: io.cacheHits }
    // Same provider/prompt/source across two subscribers: cancelling one must
    // not cancel the physical call still required by the independent owner.
    const left = createTranslationTaskOwner("left")
    const right = createTranslationTaskOwner("right")
    holdNext = true
    releaseResponse = undefined
    const sharedText =
      "V2_SOURCE_SHARED is a distinct English request used by two independent consumers."
    const first = translateTextForPage(sharedText, "plain", { source, owner: left, config }).catch(
      (error) => error,
    )
    const second = translateTextForPage(sharedText, "plain", { source, owner: right, config })
    await vi.waitFor(() => expect(releaseResponse).toBeTypeOf("function"))
    left.dispose()
    releaseResponse!()
    expect(await first).toMatchObject({ name: "TranslationCancelledError" })
    expect(await second).toContain("译文 V2_SOURCE_SHARED")
    right.dispose()
    expect(requests).toHaveLength(2)
    metrics.sharedCancellation = { http: 1, consumers: 2 }
    // A safe explicit 429 retains the existing queue retry semantics/budget.
    fail429 = true
    const retried = await translateTextForPage(
      "V2_SOURCE_RETRY requires the existing safe cooldown retry.",
      "plain",
      { source, config },
    )
    expect(retried).toContain("译文 V2_SOURCE_RETRY")
    expect(requests.slice(-2).map((value) => value.status)).toEqual([429, 200])
    metrics.safe429 = { http: 2 }
    endPageTranslationSession()
    removeAllTranslatedWrapperNodes()
    releaseWebPageContext()
    releaseWebPageSummaries()
    await vi.waitFor(() =>
      expect(providerResourceScheduler.inspect()).toMatchObject({
        active: 0,
        queued: 0,
        timers: 0,
      }),
    )
    metrics.resources = providerResourceScheduler.inspect()
    metrics.context = getContextDiagnostics()
    expect(getContextDiagnostics()).toMatchObject({
      scopes: 0,
      activePreparations: 0,
      invalidation: { observers: 0, registrations: 0 },
    })
    metrics.requests = requests
    metrics.summaryRPCs = io.summaryRPCs
    metrics.totalHTTP = requests.length
    writeFileSync("/tmp/context-v2-http.json", JSON.stringify(metrics, null, 2))
  } finally {
    releaseResponse?.()
    endPageTranslationSession()
    releaseWebPageContext()
    releaseWebPageSummaries()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
}, 30_000)
