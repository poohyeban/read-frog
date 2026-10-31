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
  handlers: new Map<string, (message: any) => Promise<any>>(),
}))
vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: (message: any) => Promise<any>) =>
    mock.handlers.set(name, handler),
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
  mock.handlers.clear()
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
  it("keeps AB through disable B, rename/add C, re-enable, and explicit detach through settings handlers", async () => {
    const b = { ...alias, apiKey: "account-b" },
      c = { ...provider, id: "c", name: "Mock C", apiKey: "account-c" }
    configSchema.parse(config([provider, b, c]))
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, b, c]))
    const runtime = await import("../resource-runtime")
    const { setupPerformanceSettings } =
      await import("@/entrypoints/background/performance-settings")
    setupPerformanceSettings()
    const read = () => mock.handlers.get("getPerformanceConfiguration")!({})
    const patch = (data: import("@/utils/request/performance-patch").PerformancePatch) =>
      mock.handlers.get("patchPerformanceConfiguration")!({ data })
    const original = await read()
    const [aId, bId, cId] = ["a", "b", "c"].map((id) => original.identities[id] as string)
    const id = "11111111-1111-4111-8111-111111111111"
    await patch({ kind: "create-group", id, name: "AB", members: [aId!, bId!] })
    await patch({ kind: "set", target: { section: "group", id }, field: "maxInFlight", value: 4 })
    const beforeDisable = await runtime.getProviderResourceSnapshot()
    expect(beforeDisable.isCurrent()).toBe(true)
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, { ...b, enabled: false }, c]))
    expect(beforeDisable.isCurrent()).toBe(false)
    const disabled = await read()
    expect(disabled.identities.b).toBe(bId)
    expect(runtime.getResourceIdentities().has("b")).toBe(false)
    expect(
      await mock.handlers.get("getProviderResourcePolicy")!({ data: { providerId: "b" } }),
    ).toBeNull()
    await expect(runtime.getResourceProvider("b")).rejects.toThrow("configuration-changed")
    expect(
      (
        await patch({
          kind: "set",
          target: { section: "provider", id: "b" },
          field: "maxInFlight",
          value: 4,
        })
      ).providers?.b,
    ).toBeUndefined()
    await patch({ kind: "edit-group", id, name: "Renamed" })
    await patch({ kind: "edit-group", id, addMembers: [cId!] })
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, b, c]))
    await runtime.resourcePerformanceWriter.reconcile()
    expect((await read()).overrides.groups[id]).toMatchObject({
      name: "Renamed",
      members: [aId, bId, cId],
    })
    expect(
      await mock.handlers.get("getProviderResourcePolicy")!({ data: { providerId: "b" } }),
    ).toMatchObject({ maxInFlight: 4 })
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, { ...b, enabled: false }, c]))
    await patch({ kind: "edit-group", id, removeMembers: [bId!] })
    expect((await read()).overrides.groups[id].members).toEqual([aId, cId])
    // Disabled, configured identities remain valid for explicit user rebinding.
    await patch({ kind: "edit-group", id, addMembers: [bId!, bId!] })
    expect((await read()).overrides.groups[id].members).toEqual([aId, cId, bId])
    await patch({ kind: "edit-group", id, removeMembers: [bId!] })
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, b, c]))
    await runtime.resourcePerformanceWriter.reconcile()
    expect((await read()).overrides.groups[id].members).toEqual([aId, cId])
    expect(
      await mock.handlers.get("getProviderResourcePolicy")!({ data: { providerId: "b" } }),
    ).toMatchObject({ maxInFlight: 2 })
    await expect(patch({ kind: "edit-group", id, addMembers: ["forged"] })).rejects.toThrow(
      "identity changed",
    )
  })

  it("serializes delayed group persistence with provider deletion and a concurrent member addition", async () => {
    const b = { ...alias, apiKey: "account-b" },
      c = { ...provider, id: "c", name: "Mock C", apiKey: "account-c" }
    configSchema.parse(config([provider, b, c]))
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, b, c]))
    const runtime = await import("../resource-runtime")
    const { identities } = await runtime.getProviderResourceSnapshot()
    const aId = identities.get("a")!,
      bId = identities.get("b")!,
      cId = identities.get("c")!
    const id = "11111111-1111-4111-8111-111111111111"
    await runtime.resourcePerformanceWriter.patch({
      kind: "create-group",
      id,
      name: "AB",
      members: [aId, bId],
    })
    await runtime.resourcePerformanceWriter.patch({
      kind: "set",
      target: { section: "group", id },
      field: "rate",
      value: 3,
    })
    await runtime.resourcePerformanceWriter.reconcile()
    const entered = deferred(),
      release = deferred()
    const original = storage.setItem.bind(storage)
    let held = false
    const hook = vi.spyOn(storage, "setItem").mockImplementation(async (key, value) => {
      if (
        !held &&
        key === "local:performanceOverrides" &&
        (value as import("@/utils/request/performance-config").PerformanceOverrides).groups?.[id]
          ?.name === "Concurrent rename"
      ) {
        held = true
        entered.resolve()
        await release.promise
      }
      return original(key, value)
    })
    try {
      const rename = runtime.resourcePerformanceWriter.patch({
        kind: "edit-group",
        id,
        name: "Concurrent rename",
      })
      await entered.promise
      const add = runtime.resourcePerformanceWriter.patch({
        kind: "edit-group",
        id,
        addMembers: [cId],
      })
      await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, c]))
      release.resolve()
      await Promise.all([rename, add])
      const result = await runtime.resourcePerformanceWriter.reconcile()
      expect(result.groups?.[id]).toEqual({
        name: "Concurrent rename",
        members: [aId, cId],
        policy: { rate: 3 },
      })
      expect(result.providers?.a).toEqual({ maxInFlight: 1, maxAttempts: 1 })
      await expect(
        runtime.resourcePerformanceWriter.patch({ kind: "edit-group", id, addMembers: [bId] }),
      ).rejects.toThrow("identity changed")
    } finally {
      release.resolve()
      hook.mockRestore()
    }
  })

  it("preserves an identity until its last alias is deleted, rejects deleted/rotated identities, and retains edits", async () => {
    const b = { ...alias, apiKey: "account-b" },
      bAlias = {
        ...alias,
        id: "b-alias",
        name: "Disabled B alias",
        apiKey: "account-b",
        enabled: false,
      }
    configSchema.parse(config([provider, b, bAlias]))
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, b, bAlias]))
    const runtime = await import("../resource-runtime")
    const snapshot = await runtime.getProviderResourceSnapshot()
    const aId = snapshot.identities.get("a")!,
      bId = snapshot.identities.get("b")!
    const id = "11111111-1111-4111-8111-111111111111"
    await runtime.resourcePerformanceWriter.patch({
      kind: "create-group",
      id,
      name: "AB",
      members: [aId, bId, bId],
    })
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, bAlias]))
    await runtime.resourcePerformanceWriter.reconcile()
    await runtime.resourcePerformanceWriter.patch({
      kind: "edit-group",
      id,
      name: "Disabled alias remains",
    })
    const read = () =>
      storage.getItem<import("@/utils/request/performance-config").PerformanceOverrides>(
        "local:performanceOverrides",
      )
    expect((await read())?.groups?.[id]?.members).toEqual([aId, bId])
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider, { ...bAlias, apiKey: "rotated-b" }]))
    await runtime.resourcePerformanceWriter.reconcile()
    expect((await read())?.groups?.[id]).toMatchObject({
      name: "Disabled alias remains",
      members: [aId],
    })
    await expect(
      runtime.resourcePerformanceWriter.patch({ kind: "edit-group", id, addMembers: [bId] }),
    ).rejects.toThrow("identity changed")
    await put(`local:${CONFIG_STORAGE_KEY}`, config([provider]))
    await runtime.resourcePerformanceWriter.reconcile()
    await expect(
      runtime.resourcePerformanceWriter.patch({
        kind: "create-group",
        id: "22222222-2222-4222-8222-222222222222",
        name: "Deleted",
        members: [bId],
      }),
    ).rejects.toThrow("identity changed")
  })
  it("preserves tuning while the root configuration is unavailable and reconciles after recovery", async () => {
    const runtime = await import("../resource-runtime")
    await runtime.initializeProviderResources()
    await runtime.resourcePerformanceWriter.reconcile()
    const before = await storage.getItem("local:performanceOverrides")
    await put(`local:${CONFIG_STORAGE_KEY}`, null)
    await expect(runtime.resourcePerformanceWriter.reconcile()).rejects.toThrow(
      "configuration-changed",
    )
    expect(await storage.getItem("local:performanceOverrides")).toEqual(before)
    await put("local:performanceOverrides", before)
    await expect(runtime.resourcePerformanceWriter.reconcile()).rejects.toThrow(
      "configuration-changed",
    )
    expect(await storage.getItem("local:performanceOverrides")).toEqual(before)
    await put(`local:${CONFIG_STORAGE_KEY}`, config())
    await expect(runtime.getResourceProvider("a")).resolves.toMatchObject({ id: "a" })
  })
  it("reconciles removed provider policies and orphan members, preserving a disabled account alias", async () => {
    const runtime = await import("../resource-runtime")
    await runtime.initializeProviderResources()
    const old = runtime.getResourceIdentities().get("a")!
    await put("local:performanceOverrides", {
      version: 1,
      revision: 2,
      providers: { a: { rate: 12 }, b: { maxInFlight: 4 }, deleted: { rate: 1 } },
      groups: { shared: { name: "Keep", members: [old], policy: { maxInFlight: 3 } } },
    })
    await put(
      `local:${CONFIG_STORAGE_KEY}`,
      config([
        { ...provider, apiKey: "rotated" },
        { ...alias, enabled: false },
      ]),
    )
    await runtime.getProviderResourceSnapshot()
    await runtime.resourcePerformanceWriter.reconcile()
    const read = () =>
      storage.getItem<import("@/utils/request/performance-config").PerformanceOverrides>(
        "local:performanceOverrides",
      )
    expect((await read())?.groups?.shared?.members).toEqual([old])
    expect((await read())?.providers).toEqual({ a: { rate: 12 }, b: { maxInFlight: 4 } })
    await put(`local:${CONFIG_STORAGE_KEY}`, config([{ ...provider, apiKey: "rotated" }]))
    await runtime.getProviderResourceSnapshot()
    await runtime.resourcePerformanceWriter.reconcile()
    expect((await read())?.groups?.shared).toEqual({
      name: "Keep",
      members: [],
      policy: { maxInFlight: 3 },
    })
    expect((await read())?.providers).toEqual({ a: { rate: 12 } })
  })
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
  it.each(["hmac", "persistence"])(
    "uses one immutable revision snapshot across delayed %s and rapid multi-provider/group edits",
    async (delay) => {
      const runtime = await import("../resource-runtime")
      await runtime.initializeProviderResources()
      const old = runtime.getResourceIdentities().get("a")!
      await put("local:performanceOverrides", {
        version: 1,
        revision: 2,
        groups: { shared: { name: "Old account", members: [old], policy: { maxInFlight: 1 } } },
      })
      await runtime.getProviderResourceSnapshot()
      const entered = deferred(),
        release = deferred()
      const sign = crypto.subtle.sign.bind(crypto.subtle)
      const setItems = storage.setItems.bind(storage)
      let held = false
      const hold = async () => {
        if (!held) {
          held = true
          entered.resolve()
          await release.promise
        }
      }
      const hook =
        delay === "hmac"
          ? vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
              await hold()
              return sign(...args)
            })
          : vi.spyOn(storage, "setItems").mockImplementation(async (...args) => {
              await hold()
              return setItems(...args)
            })
      try {
        await put(`local:${CONFIG_STORAGE_KEY}`, config([{ ...provider, apiKey: "key-a1" }, alias]))
        await entered.promise
        const waitingBeforeLatest = runtime.getResourceProvider("b")
        await put(
          `local:${CONFIG_STORAGE_KEY}`,
          config([
            { ...provider, apiKey: "key-a2" },
            { ...alias, apiKey: "key-b2" },
          ]),
        )
        const latestA = { ...provider, apiKey: "key-a3" },
          latestB = { ...alias, apiKey: "key-b3" }
        const oldAlias = { ...provider, id: "old-alias" }
        await put(`local:${CONFIG_STORAGE_KEY}`, config([latestA, latestB, oldAlias]))
        await put("local:performanceOverrides", {
          version: 1,
          revision: 3,
          groups: {
            moved: { name: "Moved while resolving", members: [old], policy: { maxInFlight: 4 } },
          },
        })
        release.resolve()
        expect((await waitingBeforeLatest).apiKey).toBe("key-b3")
        const snapshot = await runtime.getProviderResourceSnapshot()
        expect(snapshot.identities.get("b")).not.toBe(old)
        expect(snapshot.identities.get("a")).not.toBe(snapshot.identities.get("b"))
        expect(snapshot.identities.get("old-alias")).toBe(old)
        expect(runtime.providerResourceScheduler.policy(old).maxInFlight).toBe(4)
        for (const id of ["a", "b"]) {
          const effective = await runtime.getResourceProvider(id)
          expect(Object.isFrozen(effective)).toBe(true)
          expect(
            runtime.providerResourceScheduler.policy(snapshot.identities.get(id)!).maxInFlight,
          ).toBe(2)
        }
        // Re-resolve the same material under fresh aliases: identity cannot be a stale cache tag.
        await put(
          `local:${CONFIG_STORAGE_KEY}`,
          config([
            latestA,
            latestB,
            oldAlias,
            { ...latestA, id: "check-a" },
            { ...latestB, id: "check-b" },
          ]),
        )
        const verified = await runtime.getProviderResourceSnapshot()
        expect(verified.identities.get("a")).toBe(verified.identities.get("check-a"))
        expect(verified.identities.get("b")).toBe(verified.identities.get("check-b"))
      } finally {
        release.resolve()
        hook.mockRestore()
      }
    },
  )
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
