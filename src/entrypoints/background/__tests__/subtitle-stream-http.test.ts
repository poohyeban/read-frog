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
  owners: new Map<string, number>(),
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
      await mock.handlers.get(type)!({
        data: structuredClone(data),
        sender: { tab: { id: mock.owners.get(data.sessionId ?? data.lease) ?? 7 } },
      }),
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

function event() {
  const listeners = new Set<(value?: any) => void>()
  return {
    addListener: (fn: (value?: any) => void) => listeners.add(fn),
    removeListener: (fn: (value?: any) => void) => listeners.delete(fn),
    emit: (value?: any) => {
      for (const fn of listeners) fn(value)
    },
    listeners,
  }
}
function ports(name: string) {
  let closed = false
  const a = {
    name,
    onMessage: event(),
    onDisconnect: event(),
    postMessage: (value: any) => {
      b.sender.tab.id =
        mock.owners.get(value.traceId ?? value.payload?.sessionId) ?? b.sender.tab.id
      queueMicrotask(() => b.onMessage.emit(structuredClone(value)))
    },
    disconnect: () => disconnect(),
  }
  const b = {
    ...a,
    sender: { tab: { id: 7 } },
    onMessage: event(),
    onDisconnect: event(),
    postMessage: (value: any) => {
      if (value.lease) mock.owners.set(value.lease, b.sender.tab.id)
      queueMicrotask(() => a.onMessage.emit(structuredClone(value)))
    },
  }
  function disconnect() {
    if (closed) return
    closed = true
    queueMicrotask(() => {
      a.onDisconnect.emit()
      b.onDisconnect.emit()
    })
  }
  return { a, b }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
it.each([
  "baseline",
  "same-text-ordered",
  "same-text-unordered",
  "same-text-fallback",
  "same-text-fallback-first",
  "same-text-all-fallback",
  "zero-delta",
  "partial-cache",
  "shared-fallback",
])(
  "real SDK over local HTTP: %s",
  async (scenario) => {
    vi.resetModules()
    mock.handlers.clear()
    mock.data.clear()
    mock.cache.clear()
    mock.owners.clear()
    mock.ipc.length = 0
    vi.stubGlobal("TextEncoder", NativeTextEncoder)
    let mode = "normal",
      chunkSize = 10000,
      serial = 0,
      firstDelay = 5
    const calls: any[] = [],
      samples: any[] = [],
      portPairs: ReturnType<typeof ports>[] = []
    let releaseSharedFallback!: () => void
    const sharedFallbackReady = new Promise<void>((resolve) => {
      releaseSharedFallback = resolve
    })
    const server = createServer(async (req, res) => {
      const buffers = []
      try {
        for await (const chunk of req) buffers.push(chunk)
      } catch {
        return
      }
      const body = JSON.parse(Buffer.concat(buffers).toString())
      const indexedInput =
        body.stream &&
        body.messages
          .map((m: any) => m.content)
          .join("\n")
          .match(/\[\{"id":0,"text":.*?\}\]/)?.[0]
      const members: string[] = indexedInput
        ? JSON.parse(indexedInput).map((member: { text: string }) => member.text)
        : [...new Set<string>(JSON.stringify(body.messages).match(/mockcue-\d+/g) ?? [])]
      const testMode = mode
      const call = {
        at: performance.now(),
        stream: !!body.stream,
        members: members.length,
        memberIds: members,
        promptBytes: Buffer.byteLength(JSON.stringify(body.messages)),
        status: 200,
        usage: undefined as unknown,
        firstTokenMs: undefined as number | undefined,
      }
      calls.push(call)
      if (testMode === "429") {
        mode = "normal"
        call.status = 429
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0.05" })
        res.end(JSON.stringify({ error: { message: "Mock 429" } }))
        return
      }
      if (!body.stream) {
        await delay(firstDelay + 60)
        res.writeHead(200, { "content-type": "application/json" })
        call.usage = { input: 100, output: 20 }
        res.end(
          JSON.stringify({
            id: "mock",
            object: "chat.completion",
            created: 1,
            model: "mock",
            choices: [
              {
                index: 0,
                finish_reason: testMode === "generate-length" ? "length" : "stop",
                message: {
                  role: "assistant",
                  content: members.map((m) => `T:${m}`).join("\n%%\n"),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
        )
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      const send = (delta: object, finish_reason: string | null = null, usage?: object) => {
        if (res.destroyed) return
        call.firstTokenMs ??= performance.now() - call.at
        if (usage) call.usage = usage
        res.write(
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`,
        )
      }
      if (testMode === "zero-delta") {
        res.flushHeaders()
        await delay(10)
        req.socket.destroy()
        return
      }
      if (scenario === "shared-fallback" && members.length === 1) await sharedFallbackReady
      await delay(firstDelay)
      send({ reasoning_content: "Mock reasoning; never subtitle text" })
      if (testMode === "disconnect-before-text") {
        req.socket.destroy()
        return
      }
      const ids = members.map((_, id) => id)
      if (testMode === "same-text-unordered") ids.reverse()
      for (const id of ids) {
        if (res.destroyed) return
        if (testMode === "same-text-all-fallback" && members.length > 1) break
        if (["length", "length-tail", "same-text-fallback"].includes(testMode) && id > 0) break
        if (testMode === "same-text-fallback-first" && members.length > 1 && id === 0) continue
        const line =
          JSON.stringify({
            v: 1,
            id: testMode === "duplicate" ? 0 : id,
            text: testMode.startsWith("same-text")
              ? `${members.length === 1 ? "fallback" : `position-${id}`}:${members[id]}`
              : `T:${members[id]}`,
          }) + "\n"
        for (let start = 0; start < line.length; start += chunkSize)
          send({ content: line.slice(start, start + chunkSize) })
        if (id === 0) {
          if (testMode === "disconnect") {
            await delay(5)
            req.socket.destroy()
            return
          }
          await delay(60)
        }
      }
      if (testMode === "length-tail") send({ content: '{"v":1,"id":1,"text":"unfinished' })
      send(
        {},
        [
          "length",
          "length-tail",
          "same-text-fallback",
          "same-text-fallback-first",
          "same-text-all-fallback",
        ].includes(testMode)
          ? "length"
          : "stop",
        {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      )
      res.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as { port: number }
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
    let connect!: (port: any) => void
    browser.runtime.onConnect.addListener = vi.fn<(listener: any) => void>((listener: any) => {
      connect = listener
    })
    browser.runtime.connect = vi.fn<(...args: any[]) => any>(((options: { name: string }) => {
      const pair = ports(options.name)
      portPairs.push(pair)
      connect(pair.b)
      return pair.a
    }) as any) as typeof browser.runtime.connect
    browser.webNavigation.onCommitted.addListener = vi.fn<(...args: any[]) => any>()
    browser.tabs.onRemoved.addListener = vi.fn<() => void>()
    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    const { subtitleWorkRuntime, SubtitleWorkRuntime } = await import("../subtitle-work")
    const { providerResourceScheduler } = await import("@/utils/providers/resource-runtime")
    const { translateSubtitles } = await import("@/utils/subtitles/processor/translator")
    const { SubtitleSession } = await import("@/utils/subtitles/session")
    const admissionWaits: number[] = [],
      queueWaits: number[] = []
    const originalResourceRun = providerResourceScheduler.run.bind(providerResourceScheduler)
    vi.spyOn(providerResourceScheduler, "run").mockImplementation(((options: any, execute: any) => {
      const begin = performance.now()
      return originalResourceRun(options, (signal, permit) => {
        admissionWaits.push(performance.now() - begin)
        return execute(signal, permit)
      })
    }) as typeof providerResourceScheduler.run)
    const { RequestQueue } = await import("@/utils/request/request-queue")
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The spy explicitly restores the receiver with call(this).
    const originalEnqueue = RequestQueue.prototype.enqueue
    vi.spyOn(RequestQueue.prototype, "enqueue").mockImplementation(function (
      this: InstanceType<typeof RequestQueue>,
      thunk: any,
      scheduleAt: number,
      key: string,
      scopes?: string[],
      options?: any,
    ) {
      const begin = performance.now()
      return originalEnqueue.call(
        this,
        (signal, liveScopes) => {
          queueWaits.push(performance.now() - begin)
          return thunk(signal, liveScopes)
        },
        scheduleAt,
        key,
        scopes,
        options,
      )
    } as typeof originalEnqueue)
    const updates = await import("../subtitle-stream-updates")
    const originalRoute = updates.routeSubtitleStreamFallback
    let fallbackRoutes = 0
    vi.spyOn(updates, "routeSubtitleStreamFallback").mockImplementation((...args) => {
      const release = originalRoute(...args)
      fallbackRoutes++
      if (scenario === "shared-fallback" && fallbackRoutes >= 2) releaseSharedFallback()
      let released = false
      return () => {
        if (released) return
        released = true
        fallbackRoutes--
        release()
      }
    })
    setupSubtitlesTranslationHandlers()
    const sessions: InstanceType<typeof SubtitleSession>[] = []
    const context = { videoTitle: "local mock", subtitlesTextContent: "" }
    const run = (
      stream: boolean,
      size = 5,
      options: {
        session?: InstanceType<typeof SubtitleSession>
        offset?: number
        onPartial?: () => void
        texts?: string[]
        tabId?: number
      } = {},
    ) => {
      const session = options.session ?? new SubtitleSession()
      sessions.push(session)
      const offset = options.offset ?? ++serial * 100
      mock.owners.set(session.id, options.tabId ?? 7)
      const task = session.begin("playback", String(offset))
      mock.owners.set(task.sessionId, options.tabId ?? 7)
      const start = performance.now(),
        before = calls.length
      let first: number | undefined
      const partials: any[] = []
      const preparation: Record<string, number> = {}
      const promise = translateSubtitles(
        Array.from({ length: size }, (_, i) => ({
          start: i * 1000,
          end: i * 1000 + 900,
          text: options.texts?.[i] ?? `mockcue-${offset + i}`,
        })),
        context,
        mock.config,
        {
          ...task,
          onPreparationTiming: (stage, elapsedMs) => {
            preparation[stage] = elapsedMs
          },
          executionStrategy: stream ? "stream-v1" : undefined,
          onProvisional: (index, translation) => {
            first ??= performance.now() - start
            partials.push({ index, translation })
            options.onPartial?.()
          },
        },
      )
        .then((result) => {
          const complete = performance.now() - start
          samples.push({
            stream,
            preparation,
            mode,
            size,
            firstVisible: first ?? complete,
            firstConfirmed: complete,
            complete,
            httpStarts: calls.length - before,
            partials: partials.length,
            successful: result.filter((c) => c.translationOutcome?.status === "success").length,
          })
          return result
        })
        .finally(() => task.complete())
      return { promise, session, task, partials }
    }
    const scenarios: Record<string, () => Promise<void>> = {
      sameText: async () => {
        mode = scenario
        const texts = ["mockcue-1", "mockcue-1"]
        const a = run(true, 2, { texts, tabId: 7 }),
          b = run(true, 2, { texts, tabId: 8 })
        const [ra, rb] = await Promise.all([a.promise, b.promise])
        const fallback =
          scenario.startsWith("same-text-fallback") || scenario === "same-text-all-fallback"
        const completeIndex = scenario === "same-text-fallback-first" ? 1 : 0
        const expected =
          scenario === "same-text-all-fallback"
            ? [0, 1].map((index) => ({ index, translation: "fallback:mockcue-1" }))
            : fallback
              ? [
                  { index: completeIndex, translation: `position-${completeIndex}:mockcue-1` },
                  { index: 1 - completeIndex, translation: "fallback:mockcue-1" },
                ]
              : [0, 1].map((index) => ({ index, translation: `position-${index}:mockcue-1` }))
        if (scenario === "same-text-unordered") expected.reverse()
        expect.soft(a.partials).toEqual(expected)
        expect.soft(b.partials).toEqual(expected)
        for (const result of [ra, rb]) {
          expect(result.map((cue) => cue.translation)).toEqual(
            [...expected]
              .sort((left, right) => left.index - right.index)
              .map((cue) => cue.translation),
          )
          expect(result.map((cue) => [cue.start, cue.end, cue.text])).toEqual([
            [0, 900, texts[0]],
            [1000, 1900, texts[1]],
          ])
          expect(result.every((cue) => cue.translationOutcome?.status === "success")).toBe(true)
        }
        expect(calls).toHaveLength(fallback ? 2 : 1)
      },
      "shared-fallback": async () => {
        mode = "same-text-fallback"
        const a = run(true, 2, { texts: ["mockcue-1", "mockcue-1"], tabId: 7 })
        const b = run(true, 2, { texts: ["mockcue-2", "mockcue-1"], tabId: 8 })
        const results = await Promise.all([a.promise, b.promise])
        expect(a.partials).toEqual([
          { index: 0, translation: "position-0:mockcue-1" },
          { index: 1, translation: "fallback:mockcue-1" },
        ])
        expect(b.partials).toEqual([
          { index: 0, translation: "position-0:mockcue-2" },
          { index: 1, translation: "fallback:mockcue-1" },
        ])
        expect(
          results.every((result) =>
            result.every((cue) => cue.translationOutcome?.status === "success"),
          ),
        ).toBe(true)
        expect(calls).toHaveLength(3) // two distinct prompts; one shared identical singleton prompt
      },
      "zero-delta": async () => {
        mode = "zero-delta"
        const current = run(true, 2)
        const result = await current.promise
        expect.soft(calls).toHaveLength(1)
        expect(calls.every((call) => call.firstTokenMs === undefined)).toBe(true)
        expect(current.partials).toEqual([])
        expect(result.every((cue) => cue.translationOutcome?.status !== "success")).toBe(true)
        expect(mock.cache.size).toBe(0)
        mode = "429"
        const before = calls.length
        expect(
          (await run(true, 2).promise).every((cue) => cue.translationOutcome?.status === "success"),
        ).toBe(true)
        expect(calls.length - before).toBe(2)
      },
      "partial-cache": async () => {
        mode = "length-tail"
        const first = await run(true, 5, { offset: 700 }).promise
        expect(calls).toHaveLength(5)
        expect(first.map((cue) => cue.translation)).toEqual(
          Array.from({ length: 5 }, (_, i) => `T:mockcue-${700 + i}`),
        )
        const second = run(true, 5, { offset: 700 })
        expect(await second.promise).toEqual(first)
        expect(calls).toHaveLength(5)
        expect(second.partials).toEqual([])
        expect(
          [...mock.cache.values()].every((row) => !JSON.stringify(row).includes("unfinished")),
        ).toBe(true)
      },
      baseline: async () => {
        for (let i = 0; i < 10; i++)
          for (const stream of [false, true]) {
            const result = await run(stream).promise
            expect(result.every((c) => c.translationOutcome?.status === "success")).toBe(true)
          }
        for (const size of [5, 8, 12, 20]) {
          chunkSize = size === 5 ? 1 : 10000
          const before = calls.length,
            current = run(true, size)
          const result = await current.promise
          expect(result).toHaveLength(size)
          expect(calls.length - before).toBe(1)
          expect(current.partials.map((p) => p.index)).toEqual(
            Array.from({ length: size }, (_, i) => i),
          )
        }
        const cachedOffset = ++serial * 100
        await run(true, 5, { offset: cachedOffset }).promise
        let cacheBefore = calls.length
        expect(
          (await run(true, 5, { offset: cachedOffset }).promise).every(
            (c) => c.translationOutcome?.status === "success",
          ),
        ).toBe(true)
        expect(calls.length).toBe(cacheBefore)
        const savedPrompts = mock.config.videoSubtitles.customPromptsConfig
        mock.config.videoSubtitles.customPromptsConfig = {
          promptId: "custom",
          patterns: [
            { id: "custom", name: "custom", systemPrompt: "Translate", prompt: "{{input}}" },
          ],
        }
        cacheBefore = calls.length
        await run(true).promise
        expect(calls.slice(cacheBefore).every((c) => !c.stream)).toBe(true)
        mock.config.videoSubtitles.customPromptsConfig = savedPrompts
        firstDelay = 100
        expect(
          (await run(true).promise).every((c) => c.translationOutcome?.status === "success"),
        ).toBe(true)
        firstDelay = 5
        mode = "429"
        let before = calls.length
        expect(
          (await run(true).promise).every((c) => c.translationOutcome?.status === "success"),
        ).toBe(true)
        expect(calls.length - before).toBe(2)
        for (const failure of ["disconnect", "disconnect-before-text", "duplicate"]) {
          mode = failure
          before = calls.length
          const current = run(true),
            result = await current.promise
          expect(calls.length - before).toBe(1)
          expect(result.every((c) => c.translationOutcome?.status !== "success")).toBe(true)
          expect(
            [...mock.cache.values()].some((row) => row.subtitleInputs?.includes(result[0]!.text)),
          ).toBe(false)
        }
        mode = "length"
        before = calls.length
        const partial = await run(true).promise
        expect(partial.every((c) => c.translationOutcome?.status === "success")).toBe(true)
        expect(calls.length - before).toBe(5) // one batch + four missing members, each inherits its first start
        mode = "length-tail"
        before = calls.length
        expect(
          (await run(true).promise).every((c) => c.translationOutcome?.status === "success"),
        ).toBe(true)
        expect(calls.length - before).toBe(5)
        mode = "generate-length"
        before = calls.length
        const lengthResult = await run(false).promise
        expect(lengthResult.every((c) => c.translationOutcome?.status === "permanent")).toBe(true)
        expect(calls.length - before).toBe(1)
        mode = "normal"
        before = calls.length
        const sharedOffset = ++serial * 100
        const a = run(true, 5, { offset: sharedOffset }),
          b = run(true, 5, { offset: sharedOffset })
        const cancelled = a.promise.catch((e) => e)
        await vi.waitFor(() => expect(a.partials.length).toBeGreaterThan(0))
        expect(providerResourceScheduler.inspect().active).toBe(1)
        a.task.cancel()
        expect((await b.promise).every((c) => c.translationOutcome?.status === "success")).toBe(
          true,
        )
        await cancelled
        expect(calls.length - before).toBe(1)
        const stopped = run(true)
        const stopResult = stopped.promise.catch((e) => e)
        await vi.waitFor(() => expect(stopped.partials.length).toBeGreaterThan(0))
        const partialCount = stopped.partials.length
        await stopped.session.stop()
        await stopResult
        before = calls.length
        await delay(100)
        expect(stopped.partials).toHaveLength(partialCount)
        expect(calls.length).toBe(before)
        const interrupted = run(true)
        const interruptedResult = interrupted.promise.catch((error) => error)
        await vi.waitFor(() => expect(interrupted.partials.length).toBeGreaterThan(0))
        const atRestart = calls.length
        Object.assign(subtitleWorkRuntime, new SubtitleWorkRuntime())
        portPairs.at(-1)!.b.disconnect() // Mock Worker death: ports close; no replay of an in-flight request.
        await interruptedResult
        await delay(100)
        expect(calls.length).toBe(atRestart)
        expect(
          (await run(true).promise).every((c) => c.translationOutcome?.status === "success"),
        ).toBe(true)
      },
    }
    try {
      await scenarios[scenario.startsWith("same-text") ? "sameText" : scenario]!()
      const memberAttempts: Record<string, number> = {}
      for (const call of calls)
        for (const id of call.memberIds) memberAttempts[id] = (memberAttempts[id] ?? 0) + 1
      // Text is not an occurrence identity when this scenario deliberately repeats it.
      const attemptsToCheck =
        scenario.startsWith("same-text") || scenario === "shared-fallback"
          ? []
          : Object.values(memberAttempts)
      expect(attemptsToCheck.every((count) => count <= 3)).toBe(true)
      for (const session of sessions) await session.stop()
      await vi.waitFor(() =>
        expect(providerResourceScheduler.inspect()).toMatchObject({
          active: 0,
          queued: 0,
          timers: 0,
        }),
      )
      expect(
        portPairs.every(({ a: client, b: background }) =>
          [client, background].every(
            (p) => p.onMessage.listeners.size === 0 && p.onDisconnect.listeners.size === 0,
          ),
        ),
      ).toBe(true)
      expect(fallbackRoutes).toBe(0)
      expect(subtitleWorkRuntime.leaseCount).toBe(0)
      expect(sessions.every((session) => session.taskCount === 0)).toBe(true)
      expect(providerResourceScheduler.inspect().counters.starts).toBe(calls.length)
      if (process.env.SUBTITLE_STREAM_METRICS)
        writeFileSync(
          scenario === "baseline"
            ? process.env.SUBTITLE_STREAM_METRICS
            : `${process.env.SUBTITLE_STREAM_METRICS}.${scenario}.json`,
          JSON.stringify(
            {
              samples,
              calls,
              admissionWaits,
              queueWaits,
              memberAttempts:
                scenario.startsWith("same-text") || scenario === "shared-fallback"
                  ? undefined
                  : memberAttempts,
              textOccurrences:
                scenario.startsWith("same-text") || scenario === "shared-fallback"
                  ? memberAttempts
                  : undefined,
              resources: providerResourceScheduler.inspect(),
              fallbackRoutes,
              leases: subtitleWorkRuntime.leaseCount,
              tasks: sessions.reduce((sum, session) => sum + session.taskCount, 0),
              portListeners: portPairs.reduce(
                (sum, { a, b }) =>
                  sum +
                  a.onMessage.listeners.size +
                  a.onDisconnect.listeners.size +
                  b.onMessage.listeners.size +
                  b.onDisconnect.listeners.size,
                0,
              ),
              scope:
                "Real local HTTP and AI SDK; simulated IPC ports/storage, synthetic usage, not native MV3 or real model quality/cost",
            },
            null,
            2,
          ),
        )
    } finally {
      for (const session of sessions) session.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  30000,
)
