import { writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { TextEncoder as NativeTextEncoder } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import { browser } from "#imports"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => any>(),
  data: new Map<string, any>(),
  cache: new Map<string, any>(),
  config: null as any,
  ipc: [] as string[],
}))
vi.mock("@/utils/config/init", () => ({
  ensureConfigInitialized: async () => ({ isFreshInstall: false }),
}))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: async () => mock.config }))
vi.mock("../config", () => ({ ensureInitializedConfig: async () => mock.config }))
vi.mock("wxt/utils/storage", () => ({
  storage: {
    getItem: async (key: string) => structuredClone(mock.data.get(key) ?? null),
    setItem: async (key: string, value: unknown) => {
      mock.data.set(key, structuredClone(value))
    },
    setItems: async (items: { key: string; value: unknown }[]) => {
      for (const item of items) mock.data.set(item.key, structuredClone(item.value))
    },
    watch: () => () => {},
  },
}))
vi.mock("@/utils/message", () => ({
  onMessage: (type: string, handler: any) => mock.handlers.set(type, handler),
  sendMessage: async (type: string, data: any) => {
    mock.ipc.push(type)
    return structuredClone(
      await mock.handlers.get(type)!({ data: structuredClone(data), sender: { tab: { id: 7 } } }),
    )
  },
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    translationCache: {
      get: async (key: string) => mock.cache.get(key),
      put: async (row: any) => {
        mock.cache.set(row.key, structuredClone(row))
      },
    },
  },
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("runs the real SDK, scheduler, queues and content translator against local HTTP only", async () => {
  vi.stubGlobal("TextEncoder", NativeTextEncoder)
  const calls: { at: number; members: number; promptBytes: number; status: number }[] = []
  let failure = "",
    remaining = 0
  const server = createServer(async (req, res) => {
    const buffers = []
    try {
      for await (const chunk of req) buffers.push(chunk)
    } catch {
      return
    }
    const body = JSON.parse(Buffer.concat(buffers).toString())
    const text = JSON.stringify(body.messages)
    const members = [...new Set(text.match(/mockcue-\d+/g) ?? [])]
    const fail = remaining-- > 0 ? failure : ""
    calls.push({
      at: Date.now(),
      members: members.length,
      promptBytes: Buffer.byteLength(text),
      status: fail === "429" ? 429 : fail === "network" ? 0 : 200,
    })
    if (fail === "network") {
      req.socket.destroy()
      return
    }
    if (fail === "429") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0.2" })
      res.end(JSON.stringify({ error: { message: "local mock cooldown", type: "rate_limit" } }))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: "mock",
        object: "chat.completion",
        created: 1,
        model: "mock",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: members.map((member) => `T:${member}`).join("\n%%\n"),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  // vitest.setup replaces TextEncoder with a jsdom shim. Undici may already
  // have captured it; supply UTF-8 bytes without changing the actual HTTP stack.
  const nativeFetch = globalThis.fetch
  vi.stubGlobal("fetch", ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(`http://127.0.0.1:${address.port}/`))
      throw new Error("Non-local test request refused")
    return nativeFetch(input, {
      ...init,
      body: typeof init?.body === "string" ? Buffer.from(init.body, "utf8") : init?.body,
    })
  }) satisfies typeof fetch)
  mock.config = {
    ...structuredClone(DEFAULT_CONFIG),
    providersConfig: [
      {
        ...DEFAULT_PROVIDER_CONFIG["openai-compatible"],
        id: "local-mock",
        enabled: true,
        apiKey: "mock-only",
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        model: { model: "mock", isCustomModel: false, customModel: null },
      },
    ],
    glossary: { ...DEFAULT_CONFIG.glossary, enabled: false },
    videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, providerId: "local-mock" },
  }
  mock.data.set("local:performanceOverrides", {
    version: 1,
    revision: 1,
    providers: {
      "local-mock": {
        rate: 100,
        capacity: 100,
        maxAttempts: 3,
        baseRetryDelayMs: 100,
        cooldownMs: 100,
      },
    },
  })
  browser.tabs.onRemoved.addListener = vi.fn<(...args: any[]) => any>()
  const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
  const { subtitleWorkRuntime, SubtitleWorkRuntime } = await import("../subtitle-work")
  const { providerResourceScheduler } = await import("@/utils/providers/resource-runtime")
  const { translateSubtitles } = await import("@/utils/subtitles/processor/translator")
  const { SubtitleSession } = await import("@/utils/subtitles/session")
  const { createSubtitleTranslationPlan } = await import("@/utils/subtitles/translation-plan")
  const { sendMessage } = await import("@/utils/message")
  setupSubtitlesTranslationHandlers()
  const session = new SubtitleSession()
  const source = (offset = 0) =>
    Array.from({ length: 5 }, (_, i) => ({
      start: i * 1000,
      end: i * 1000 + 900,
      text: `mockcue-${offset + i}`,
    }))
  const context = { videoTitle: "local mock", subtitlesTextContent: "" }
  const run = async (offset: number) => {
    const task = session.begin("playback", String(offset))
    try {
      return await translateSubtitles(source(offset), context, mock.config, task)
    } finally {
      task.complete()
    }
  }
  const metrics: Record<string, unknown> = {}
  try {
    const legacyTask = session.begin("playback", "legacy")
    const work = await legacyTask.prepareWork!("fast", 0, 4900)
    let stamp = Date.now()
    const ready: number[] = []
    const oldIpc = mock.ipc.length
    await Promise.all(
      source().map(async (cue, index) => {
        const plan = createSubtitleTranslationPlan({
          text: cue.text,
          langConfig: mock.config.language,
          providerRef: { kind: "local", config: mock.config.providersConfig[0] },
          promptConfig: mock.config.videoSubtitles,
          scheduleAt: Date.now(),
          work,
          sessionId: legacyTask.sessionId,
          resultFormat: "outcome",
        })
        const result = await sendMessage("enqueueSubtitlesTranslateRequest", plan.request)
        expect(result).toMatchObject({ outcome: { status: "success" } })
        ready[index] = Date.now() - stamp
      }),
    )
    legacyTask.complete()
    metrics.legacy = {
      requests: calls.length,
      members: calls.map((call) => call.members),
      ipc: mock.ipc.slice(oldIpc).filter((type) => type === "enqueueSubtitlesTranslateRequest")
        .length,
      firstMs: ready[0],
      fifthMs: ready[4],
    }
    expect(calls.map((call) => call.members)).toEqual([4, 1])
    const before = calls.length,
      ipcBefore = mock.ipc.length
    stamp = Date.now()
    expect((await run(10)).every((cue) => cue.translationOutcome?.status === "success")).toBe(true)
    metrics.planned = {
      requests: calls.length - before,
      members: calls.slice(before).map((call) => call.members),
      ipc: mock.ipc.slice(ipcBefore).filter((type) => type === "enqueueSubtitlesTranslateBatch")
        .length,
      firstMs: Date.now() - stamp,
      fifthMs: Date.now() - stamp,
    }
    expect(calls.length - before).toBe(1)
    await run(10)
    expect(calls.length - before).toBe(1)
    failure = "429"
    remaining = 1
    let checkpoint = calls.length
    expect((await run(20)).every((cue) => cue.translationOutcome?.status === "success")).toBe(true)
    expect(calls.slice(checkpoint).map((call) => call.status)).toEqual([429, 200])
    expect(calls[checkpoint + 1]!.at - calls[checkpoint]!.at).toBeGreaterThanOrEqual(190)
    failure = "network"
    remaining = 1
    checkpoint = calls.length
    expect((await run(30)).every((cue) => cue.translationOutcome?.status === "success")).toBe(true)
    expect(calls.length - checkpoint).toBe(2)
    Object.assign(subtitleWorkRuntime, new SubtitleWorkRuntime())
    checkpoint = calls.length
    expect((await run(40)).every((cue) => cue.translationOutcome?.status === "success")).toBe(true)
    expect(calls.length - checkpoint).toBe(1)
    failure = "429"
    remaining = 10
    checkpoint = calls.length
    const exhausted = await run(50)
    expect(calls.length - checkpoint).toBe(3)
    expect(
      exhausted.every(
        (cue) =>
          cue.translationOutcome?.status === "temporary" && cue.translationOutcome.retryExhausted,
      ),
    ).toBe(true)
    await session.stop()
    const stopped = calls.length
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(calls.length).toBe(stopped)
    expect(providerResourceScheduler.inspect()).toMatchObject({ active: 0, queued: 0, timers: 0 })
    metrics.calls = calls
    metrics.usage =
      "Mock reports 100 input / 20 output tokens per successful response; synthetic, not real model tokenization."
    metrics.scope =
      "Real local HTTP + AI SDK + ResourceScheduler + RequestQueue + BatchQueue + content translator; message bus and storage mocked, not native MV3."
    if (process.env.SUBTITLE_HTTP_METRICS)
      writeFileSync(process.env.SUBTITLE_HTTP_METRICS, JSON.stringify(metrics, null, 2))
  } finally {
    session.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 20000)
