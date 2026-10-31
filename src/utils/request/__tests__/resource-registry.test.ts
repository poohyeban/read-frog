import { describe, expect, it } from "vitest"
import { validatePerformanceOverrides, emptyPerformanceOverrides } from "../performance-config"
import { RESOURCE_DEFAULTS } from "../resource-policy"
import { resolveResourceRegistry } from "../resource-registry"
const ids = new Map([
  ["first", "physical-a"],
  ["alias", "physical-a"],
  ["second", "physical-b"],
])
describe("resource identity, grouping and policy resolution", () => {
  it("uses one credential domain for aliases without duplicate token deductions", () => {
    const result = resolveResourceRegistry(ids, emptyPerformanceOverrides())
    expect(result.domains).toHaveLength(2)
    expect(result.paths.get("physical-a")).toEqual(["physical-a"])
    expect(result.domains[0]!.policy).toEqual(RESOURCE_DEFAULTS)
  })
  it("lets explicit alias limits exceed defaults and resolves conflicting overrides conservatively", () => {
    const result = resolveResourceRegistry(ids, {
      version: 1,
      revision: 1,
      providers: { first: { maxInFlight: 8, rate: 20 }, alias: { rate: 10 } },
    })
    expect(result.domains[0]!.policy).toMatchObject({ maxInFlight: 8, rate: 10 })
  })
  it("inherits group defaults while retaining explicit per-credential limits", () => {
    const result = resolveResourceRegistry(ids, {
      version: 1,
      revision: 1,
      providers: { first: { maxInFlight: 1 } },
      groups: {
        shared: {
          name: "Group",
          members: ["physical-a", "physical-b"],
          policy: { maxInFlight: 4, maxAttempts: 5 },
        },
      },
    })
    expect(result.domains.find((d) => d.id === "physical-a")!.policy).toMatchObject({
      maxInFlight: 1,
      maxAttempts: 5,
    })
    expect(result.domains.find((d) => d.id === "physical-b")!.policy.maxInFlight).toBe(4)
    expect(result.paths.get("physical-b")).toEqual(["physical-b", "group:shared"])
  })
  it("rejects double membership, illegal values and contradictory delays", () => {
    expect(() =>
      validatePerformanceOverrides({
        version: 1,
        revision: 0,
        groups: { a: { name: "A", members: ["key"] }, b: { name: "B", members: ["key"] } },
      }),
    ).toThrow(/physical resource|Invalid|delay|small|big|finite/i)
    for (const policy of [
      { maxInFlight: 0 },
      { rate: Infinity },
      { maxAttempts: 100 },
      { maxQueued: -1 },
      { baseRetryDelayMs: 30000, maxRetryDelayMs: 100 },
    ])
      expect(() =>
        validatePerformanceOverrides({ version: 1, revision: 0, providers: { first: policy } }),
      ).toThrow(/physical resource|Invalid|delay|small|big|finite/i)
  })
})
