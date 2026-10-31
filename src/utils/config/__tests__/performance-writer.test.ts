import type { PerformanceOverrides } from "@/utils/request/performance-config"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RESOURCE_DEFAULTS } from "@/utils/request/resource-policy"
import { createPerformanceWriter } from "../performance-writer"
let stored: PerformanceOverrides | undefined
const write = vi.fn<(value: PerformanceOverrides) => Promise<void>>(async (value) => {
  stored = structuredClone(value)
})
const identities = new Map([
  ["provider", "resource-a"],
  ["alias", "resource-a"],
  ["other", "resource-b"],
])
const context = async () => ({
  identities,
  configuredIdentities: identities,
  providerIds: new Set(identities.keys()),
  isCurrent: () => true,
})
const create = () =>
  createPerformanceWriter({ read: async () => structuredClone(stored), write, context })
const groupId = "11111111-1111-4111-8111-111111111111"
beforeEach(() => {
  stored = undefined
  write.mockClear()
})
describe("Defaults + Sparse Overrides serialized writer", () => {
  it("merges independent group edits, keeps inherited tuning, and never resurrects a concurrently removed member", async () => {
    stored = {
      version: 1,
      revision: 1,
      groups: {
        [groupId]: {
          name: "AB",
          members: ["resource-a", "resource-b"],
          policy: { maxInFlight: 4 },
        },
      },
    }
    const all = new Map([...identities, ["third", "resource-c"], ["fourth", "resource-d"]])
    const writer = createPerformanceWriter({
      read: async () => structuredClone(stored),
      write,
      context: async () => ({
        identities: all,
        configuredIdentities: all,
        providerIds: new Set(all.keys()),
        isCurrent: () => true,
      }),
    })
    await Promise.all([
      writer.patch({ kind: "edit-group", id: groupId, name: "Renamed" }),
      writer.patch({ kind: "edit-group", id: groupId, addMembers: ["resource-c"] }),
      writer.patch({ kind: "edit-group", id: groupId, removeMembers: ["resource-b"] }),
      writer.patch({ kind: "edit-group", id: groupId, addMembers: ["resource-d"] }),
    ])
    expect(stored?.groups?.[groupId]).toEqual({
      name: "Renamed",
      members: ["resource-a", "resource-c", "resource-d"],
      policy: { maxInFlight: 4 },
    })
    const count = write.mock.calls.length
    await writer.patch({
      kind: "edit-group",
      id: groupId,
      name: "Renamed",
      addMembers: ["resource-c"],
      removeMembers: ["resource-b"],
    })
    expect(write).toHaveBeenCalledTimes(count)
  })

  it("validates additions against configured accounts and rejects conflicting or obsolete replacement payloads", async () => {
    stored = {
      version: 1,
      revision: 1,
      groups: { [groupId]: { name: "A", members: ["resource-a"] } },
    }
    const writer = create()
    await expect(
      writer.patch({ kind: "edit-group", id: groupId, addMembers: ["forged"] }),
    ).rejects.toThrow("identity changed")
    await expect(
      writer.patch({
        kind: "edit-group",
        id: groupId,
        addMembers: ["resource-b"],
        removeMembers: ["resource-b"],
      }),
    ).rejects.toThrow("Cannot add and remove")
    await expect(
      writer.patch({
        kind: "edit-group",
        id: groupId,
        name: "Old client",
        members: ["resource-b"],
      } as unknown as import("@/utils/request/performance-patch").PerformancePatch),
    ).rejects.toThrow("Unrecognized key")
    expect(write).not.toHaveBeenCalled()
  })

  it("rejects edits to a concurrently deleted group without recreating it", async () => {
    const writer = create()
    await writer.patch({
      kind: "create-group",
      id: groupId,
      name: "AB",
      members: ["resource-a", "resource-b"],
    })
    const deleted = writer.patch({ kind: "delete-group", id: groupId })
    const stale = writer.patch({
      kind: "edit-group",
      id: groupId,
      name: "Stale",
      addMembers: ["resource-b"],
    })
    await deleted
    await expect(stale).rejects.toThrow("Resource group changed")
    expect(stored?.groups).toBeUndefined()
  })

  it("rejects an identity snapshot invalidated before persistence without changing valid user settings", async () => {
    stored = {
      version: 1,
      revision: 1,
      groups: {
        [groupId]: { name: "AB", members: ["resource-a", "resource-b"], policy: { rate: 3 } },
      },
    }
    let resume!: () => void
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    let current = true
    const writer = createPerformanceWriter({
      read: async () => structuredClone(stored),
      write,
      context: async () => {
        await gate
        return { ...(await context()), isCurrent: () => current }
      },
    })
    const result = writer.patch({ kind: "edit-group", id: groupId, name: "Stale" })
    current = false
    resume()
    await expect(result).rejects.toThrow("identity changed")
    expect(write).not.toHaveBeenCalled()
    expect(stored?.groups?.[groupId]?.name).toBe("AB")
    current = true
    await writer.patch({ kind: "edit-group", id: groupId, name: "Fresh" })
    expect(stored?.groups?.[groupId]).toEqual({
      name: "Fresh",
      members: ["resource-a", "resource-b"],
      policy: { rate: 3 },
    })
  })
  it("cleans only unreferenced identities/deleted providers and preserves disabled aliases and group policy", async () => {
    stored = {
      version: 1,
      revision: 4,
      providers: { provider: { rate: 12 }, disabled: { maxInFlight: 4 }, deleted: { rate: 1 } },
      groups: {
        shared: { name: "Keep my policy", members: ["resource-a", "retired"], policy: { rate: 3 } },
      },
      subtitles: { fastAheadMs: 40000 },
    }
    const resources = new Set(["resource-a", "resource-new"])
    const writer = createPerformanceWriter({
      read: async () => stored,
      write,
      context: async () => ({
        identities: new Map([["provider", "resource-new"]]),
        configuredIdentities: new Map([
          ["provider", "resource-new"],
          ["disabled", "resource-a"],
        ]),
        providerIds: new Set(["provider", "disabled"]),
        resourceIds: resources,
        isCurrent: () => true,
      }),
    })
    await Promise.all([
      writer.reconcile(),
      writer.patch({
        kind: "set",
        target: { section: "provider", id: "provider" },
        field: "maxAttempts",
        value: 5,
      }),
    ])
    expect(stored?.providers).toEqual({
      provider: { rate: 12, maxAttempts: 5 },
      disabled: { maxInFlight: 4 },
    })
    expect(stored?.groups?.shared?.members).toEqual(["resource-a"])
    expect(stored?.subtitles?.fastAheadMs).toBe(40000)
    resources.delete("resource-a")
    await writer.reconcile()
    expect(stored?.groups?.shared).toEqual({
      name: "Keep my policy",
      members: [],
      policy: { rate: 3 },
    })
    const writes = write.mock.calls.length
    await writer.reconcile()
    expect(write).toHaveBeenCalledTimes(writes)
  })
  it("does not erase group membership when identity resolution is incomplete", async () => {
    stored = {
      version: 1,
      revision: 1,
      providers: { deleted: { rate: 1 } },
      groups: { shared: { name: "Keep", members: ["resource-a"] } },
    }
    const writer = createPerformanceWriter({
      read: async () => stored,
      write,
      context: async () => ({
        identities: new Map(),
        configuredIdentities: new Map(),
        providerIds: new Set(["provider"]),
        isCurrent: () => true,
      }),
    })
    await writer.reconcile()
    await writer.patch({ kind: "edit-group", id: "shared", name: "Keep renamed" })
    expect(stored?.groups?.shared?.name).toBe("Keep renamed")
    expect(stored?.providers).toBeUndefined()
    expect(stored?.groups?.shared?.members).toEqual(["resource-a"])
  })
  it("does not persist defaults, identical values or empty resets", async () => {
    const writer = create()
    for (const [field, value] of Object.entries(RESOURCE_DEFAULTS))
      await writer.patch({
        kind: "set",
        target: { section: "provider", id: "provider" },
        field,
        value,
      })
    await writer.patch({ kind: "reset", target: { section: "global" } })
    expect(write).not.toHaveBeenCalled()
    expect(stored).toBeUndefined()
  })
  it("merges simultaneous field patches from different tabs and unsets values equal to defaults", async () => {
    const writer = create()
    await Promise.all([
      writer.patch({
        kind: "set",
        target: { section: "provider", id: "provider" },
        field: "rate",
        value: 12,
      }),
      writer.patch({
        kind: "set",
        target: { section: "provider", id: "provider" },
        field: "maxInFlight",
        value: 4,
      }),
      writer.patch({
        kind: "set",
        target: { section: "subtitles" },
        field: "diagnostics",
        value: true,
      }),
    ])
    expect(stored).toEqual({
      version: 1,
      revision: 3,
      providers: { provider: { rate: 12, maxInFlight: 4 } },
      subtitles: { diagnostics: true },
    })
    await writer.patch({
      kind: "set",
      target: { section: "provider", id: "provider" },
      field: "rate",
      value: RESOURCE_DEFAULTS.rate,
    })
    expect(stored?.providers?.provider).toEqual({ maxInFlight: 4 })
    await writer.patch({ kind: "reset", target: { section: "provider", id: "provider" } })
    expect(stored?.providers).toBeUndefined()
    expect(stored?.subtitles?.diagnostics).toBe(true)
  })
  it("isolates invalid edits and continues applying subsequent valid patches", async () => {
    const writer = create()
    const results = await Promise.allSettled([
      writer.patch({
        kind: "set",
        target: { section: "provider", id: "provider" },
        field: "maxInFlight",
        value: -1,
      }),
      writer.patch({
        kind: "set",
        target: { section: "provider", id: "provider" },
        field: "maxAttempts",
        value: 5,
      }),
    ])
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"])
    expect(stored?.revision).toBe(1)
    expect(stored?.providers?.provider).toEqual({ maxAttempts: 5 })
    await expect(
      writer.patch({
        kind: "set",
        target: { section: "provider", id: "provider" },
        field: "unlimited",
        value: 1,
      }),
    ).rejects.toThrow("Unknown resource setting")
  })
  it("groups physical resources only once and inherits group defaults for sparse credential overrides", async () => {
    const writer = create()
    await writer.patch({
      kind: "create-group",
      id: groupId,
      name: "Account group",
      members: ["resource-a", "resource-b"],
    })
    await writer.patch({
      kind: "set",
      target: { section: "group", id: groupId },
      field: "maxInFlight",
      value: 4,
    })
    await writer.patch({
      kind: "set",
      target: { section: "provider", id: "provider" },
      field: "maxInFlight",
      value: 4,
    })
    expect(stored?.providers).toBeUndefined()
    await writer.patch({
      kind: "set",
      target: { section: "provider", id: "provider" },
      field: "maxInFlight",
      value: 2,
    })
    expect(stored?.providers?.provider?.maxInFlight).toBe(2)
    await expect(
      writer.patch({
        kind: "create-group",
        id: "22222222-2222-4222-8222-222222222222",
        name: "Duplicate",
        members: ["resource-a"],
      }),
    ).rejects.toThrow("only one")
    await writer.patch({ kind: "reset", target: { section: "group", id: groupId } })
    expect(stored?.groups?.[groupId]?.policy).toBeUndefined()
    expect(stored?.groups?.[groupId]?.members).toHaveLength(2)
    await writer.patch({ kind: "delete-group", id: groupId })
    expect(stored?.groups).toBeUndefined()
  })
  it("explicit full reset clears only tuning even if saved authentication cannot be resolved", async () => {
    stored = {
      version: 1,
      revision: 7,
      providers: { provider: { maxInFlight: 8 } },
      groups: { [groupId]: { name: "Shared", members: ["resource-a"], policy: { rate: 2 } } },
      subtitles: { diagnostics: true },
    }
    const unavailable = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error("invalid credentials"))
    const writer = createPerformanceWriter({
      read: async () => stored,
      write,
      context: unavailable,
    })
    await writer.patch({ kind: "reset-all" })
    expect(unavailable).not.toHaveBeenCalled()
    expect(stored).toEqual({ version: 1, revision: 8 })
    await writer.patch({ kind: "reset-all" })
    expect(write).toHaveBeenCalledTimes(1)
  })
  it("does not persist failed writes and preserves a subsequent tab's edit", async () => {
    const writer = create()
    write.mockRejectedValueOnce(new Error("storage unavailable"))
    await expect(
      writer.patch({ kind: "set", target: { section: "global" }, field: "maxInFlight", value: 10 }),
    ).rejects.toThrow("storage unavailable")
    expect(stored).toBeUndefined()
    await writer.patch({
      kind: "set",
      target: { section: "global" },
      field: "maxQueued",
      value: 300,
    })
    expect(stored?.global).toEqual({ maxQueued: 300 })
    expect(stored?.revision).toBe(1)
  })
})
