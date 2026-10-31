import type { LLMProviderConfig } from "@/types/config/provider"
vi.mock("@/utils/config/init", () => ({
  ensureConfigInitialized: async () => ({ isFreshInstall: false }),
}))
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { DEFAULT_CONFIG, CONFIG_STORAGE_KEY } from "@/utils/constants/config"
const mock = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  watchers: new Map<string, Set<(value: unknown) => void>>(),
  reads: vi.fn<(key: string) => void>(),
  writes: vi.fn<(key: string) => void>(),
}))
vi.mock("wxt/utils/storage", () => ({
  storage: {
    getItem: async (key: string) => {
      mock.reads(key)
      return structuredClone(mock.data.get(key) ?? null)
    },
    setItem: async (key: string, value: unknown) => {
      mock.writes(key)
      mock.data.set(key, structuredClone(value))
      mock.watchers.get(key)?.forEach((w) => w(structuredClone(value)))
    },
    setItems: async (items: { key: string; value: unknown }[]) => {
      for (const { key, value } of items) {
        mock.writes(key)
        mock.data.set(key, structuredClone(value))
      }
    },
    watch: (key: string, listener: (value: unknown) => void) => {
      const all = mock.watchers.get(key) ?? new Set()
      all.add(listener)
      mock.watchers.set(key, all)
      return () => all.delete(listener)
    },
  },
}))
const provider: LLMProviderConfig = {
  ...DEFAULT_CONFIG.providersConfig.find((p) => p.provider === "openai")!,
  id: "a",
  name: "Mock A",
  enabled: true,
  apiKey: "mock-account",
  baseURL: "https://mock.invalid/v1",
}
const alias = { ...provider, id: "b", name: "Alias" }
async function put(key: string, value: unknown) {
  await storage.setItem(key as `local:${string}`, value)
}
function config(providers = [provider, alias]) {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    providersConfig: [...DEFAULT_CONFIG.providersConfig, ...providers],
  }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.resetModules()
  mock.data.clear()
  mock.watchers.clear()
  mock.reads.mockClear()
  mock.writes.mockClear()
  configSchema.parse(config())
  mock.data.set(`local:${CONFIG_STORAGE_KEY}`, config())
  mock.data.set("local:performanceOverrides", {
    version: 1,
    revision: 1,
    providers: { a: { maxInFlight: 1, maxAttempts: 1 } },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("background provider authority", () => {
  it("shares account aliases, keeps request hot paths free of storage/HMAC writes, and reuses installation identity", async () => {
    let runtime = await import("../resource-runtime")
    const { getLocalConfig } = await import("@/utils/config/storage")
    expect((await getLocalConfig())?.providersConfig.map((p) => p.id)).toContain("a")
    await runtime.initializeProviderResources()
    const ids = runtime.getResourceIdentities()
    expect([...ids.keys()]).toContain("a")
    expect(ids.get("a")).toBe(ids.get("b"))
    const first = deferred(),
      order: string[] = []
    const reads = mock.reads.mock.calls.length,
      writes = mock.writes.mock.calls.length
    const a = runtime.runProviderOperation(provider, undefined, async (_signal, p) => {
      p.start()
      order.push("a")
      await first.promise
    })
    const b = runtime.runProviderOperation(alias, undefined, async (_signal, p) => {
      p.start()
      order.push("b")
    })
    await flush()
    expect(order).toEqual(["a"])
    first.resolve()
    await Promise.all([a, b])
    await flush()
    expect(order).toEqual(["a", "b"])
    expect(mock.reads.mock.calls.length).toBe(reads)
    expect(mock.writes.mock.calls.length).toBe(writes)
    vi.resetModules()
    mock.watchers.clear()
    runtime = await import("../resource-runtime")
    await runtime.initializeProviderResources()
    expect(runtime.getResourceIdentities()).toEqual(ids)
  })
  it("keeps names stable but a changed key leaves the old manual group and rejects obsolete queued transport", async () => {
    const runtime = await import("../resource-runtime")
    await runtime.initializeProviderResources()
    const old = runtime.getResourceIdentities().get("a")!
    await put("local:performanceOverrides", {
      version: 1,
      revision: 2,
      groups: { shared: { name: "Shared", members: [old], policy: { maxInFlight: 1 } } },
    })
    await runtime.getResourceProvider("a")
    await put(`local:${CONFIG_STORAGE_KEY}`, config([{ ...provider, name: "Renamed" }, alias]))
    await runtime.getResourceProvider("a")
    expect(runtime.getResourceIdentities().get("a")).toBe(old)
    const changed = { ...provider, apiKey: "another-mock-account" }
    await put(`local:${CONFIG_STORAGE_KEY}`, config([changed, alias]))
    await runtime.getResourceProvider("a")
    expect(runtime.getResourceIdentities().get("a")).not.toBe(old)
    expect(runtime.getResourceIdentities().get("b")).toBe(old)
    let sends = 0
    await expect(
      runtime.runProviderOperation(provider, undefined, async (_s, p) => {
        p.start()
        sends++
      }),
    ).rejects.toThrow(/configuration-changed|denied|identity/)
    expect(sends).toBe(0)
  })
  it("checks the lease immediately before network send, including after asynchronous preparation", async () => {
    const runtime = await import("../resource-runtime")
    await runtime.initializeProviderResources()
    const ready = deferred(),
      prepared = deferred()
    let live = true,
      starts = 0
    const result = runtime
      .runProviderOperation(
        provider,
        undefined,
        async (_signal, p) => {
          prepared.resolve()
          await ready.promise
          p.start()
          starts++
        },
        () => {
          if (!live) throw Object.assign(new Error("revoked"), { isRetryable: false })
        },
      )
      .catch((e) => e)
    await prepared.promise
    live = false
    ready.resolve()
    expect((await result).message).toBe("revoked")
    expect(starts).toBe(0)
    expect(runtime.providerResourceScheduler.counters.starts).toBe(0)
  })
  it("routes the real SDK through a permit and prevents raw factory bypass", async () => {
    const runtime = await import("../resource-runtime")
    await runtime.initializeProviderResources()
    const { generateRemoteText } = await import("../remote-executor")
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: "denied" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    await expect(generateRemoteText(provider, { prompt: "Mock only" })).rejects.toThrow(
      /configuration-changed|denied|identity/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(runtime.providerResourceScheduler.counters.starts).toBe(1)
    // Even a caller of the raw factory cannot send without a physical permit.
    const { getLanguageModelForConfig } = await import("../model")
    const { generateText } = await import("ai")
    await expect(
      generateText({ model: getLanguageModelForConfig(provider), prompt: "bypass", maxRetries: 0 }),
    ).rejects.toThrow(/configuration-changed|denied|identity/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it("holds the real SDK stream permit until the stream ends", async () => {
    const { DEFAULT_PROVIDER_CONFIG } = await import("@/utils/constants/providers")
    const compatible = {
      ...DEFAULT_PROVIDER_CONFIG["openai-compatible"],
      id: "a",
      name: "Mock A",
      enabled: true,
      apiKey: provider.apiKey,
      baseURL: provider.baseURL!,
      model: { ...DEFAULT_PROVIDER_CONFIG["openai-compatible"].model, customModel: "mock" },
    }
    await put(`local:${CONFIG_STORAGE_KEY}`, config([compatible, alias]))
    const runtime = await import("../resource-runtime")
    await runtime.initializeProviderResources()
    const { consumeRemoteStream } = await import("../remote-executor")
    const opened = deferred(),
      firstText = deferred()
    let source!: ReadableStreamDefaultController<Uint8Array>
    const encode = (choice: unknown) =>
      new TextEncoder().encode(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock", choices: [choice] })}\n\n`,
      )
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller
            opened.resolve()
          },
        })
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      }),
    )
    const stream = consumeRemoteStream(compatible, { prompt: "Mock only" }, async (parts) => {
      for await (const part of parts)
        if ((part as { type: string }).type === "text-delta") firstText.resolve()
      return "finished"
    })
    await opened.promise
    source.enqueue(
      encode({ index: 0, delta: { role: "assistant", content: "first" }, finish_reason: null }),
    )
    await firstText.promise
    let nextStarted = false
    const next = runtime.runProviderOperation(alias, undefined, async (_signal, permit) => {
      permit.start()
      nextStarted = true
    })
    await flush()
    expect(nextStarted).toBe(false)
    expect(runtime.providerResourceScheduler.inspect()).toMatchObject({ active: 1, queued: 1 })
    source.enqueue(encode({ index: 0, delta: {}, finish_reason: "stop" }))
    source.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
    source.close()
    expect(await stream).toBe("finished")
    await next
    expect(nextStarted).toBe(true)
    expect(runtime.providerResourceScheduler.counters.starts).toBe(2)
  })
  it("recovers a missing primary identity vault without changing manual resource bindings", async () => {
    let runtime = await import("../resource-runtime")
    await runtime.initializeProviderResources()
    const before = runtime.getResourceIdentities()
    mock.data.delete("local:resourceIdentityVault")
    mock.data.set("local:performanceOverrides", {
      version: 1,
      revision: 2,
      groups: { shared: { name: "Shared", members: [before.get("a")] } },
    })
    vi.resetModules()
    mock.watchers.clear()
    runtime = await import("../resource-runtime")
    await runtime.initializeProviderResources()
    expect(runtime.getResourceIdentities()).toEqual(before)
    expect(mock.data.has("local:resourceIdentityVault")).toBe(true)
  })
})
