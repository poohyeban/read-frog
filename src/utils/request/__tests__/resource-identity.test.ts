import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  ResourceIdentityResolver,
  type IdentityVault,
  type IdentityMaterial,
} from "../resource-identity"
const material = (key = "credential", endpoint = "https://api.example/v1/"): IdentityMaterial => ({
  endpoint,
  authentication: { authorization: `Bearer ${key}` },
})
let stored: IdentityVault | undefined
let writes = 0
const persistence = {
  read: async () => structuredClone(stored),
  write: async (value: IdentityVault) => {
    stored = structuredClone(value)
    writes++
  },
  hasBindings: async () => false,
}
beforeEach(() => {
  stored = undefined
  writes = 0
})

describe("persistent opaque resource identities", () => {
  it("shares equivalent endpoint and credential aliases across concurrent initialization and worker restart", async () => {
    const resolver = new ResourceIdentityResolver(persistence)
    const [a, b] = await Promise.all([
      resolver.update("a", "1", material()),
      resolver.update("b", "1", material("credential", "https://API.example:443/v1")),
    ])
    expect(a).toBe(b)
    expect(await new ResourceIdentityResolver(persistence).update("a", "1", material())).toBe(a)
    expect(writes).toBe(2) // One durable root and one resource binding.
    expect(JSON.stringify(stored)).not.toContain("credential")
    expect(JSON.stringify(stored)).not.toContain("api.example")
  })
  it("isolates keys, paths, tenants and organization/project boundaries", async () => {
    const r = new ResourceIdentityResolver(persistence)
    const inputs = [
      material(),
      material("second"),
      material("credential", "https://api.example/V1"),
      material("credential", "https://api.example/tenant/v1"),
      { ...material(), organization: "org" },
      { ...material(), project: "project" },
    ]
    const ids = await Promise.all(inputs.map((input, i) => r.update(String(i), "1", input)))
    expect(new Set(ids).size).toBe(inputs.length)
  })
  it("memoizes by transport revision and keeps a verified OAuth subject stable across access-token rotation", async () => {
    const r = new ResourceIdentityResolver(persistence)
    const oauth = { issuer: "https://auth.example", subject: "account-42", verified: true }
    const first = await r.update("oauth", "1", { ...material("token-a"), stableAccount: oauth })
    for (let i = 0; i < 100; i++) expect(r.get("oauth", "1")).toBe(first)
    expect(r.resolutionCount).toBe(1)
    expect(await r.update("oauth", "2", { ...material("token-b"), stableAccount: oauth })).toBe(
      first,
    )
    expect(
      await r.update("oauth", "3", {
        ...material("token-b"),
        stableAccount: { ...oauth, verified: false },
      }),
    ).not.toBe(first)
  })
  it("never silently rotates an unreadable or missing root with existing group bindings", async () => {
    const write = vi.fn<(value: IdentityVault) => Promise<void>>()
    const missing = new ResourceIdentityResolver({
      ...persistence,
      write,
      hasBindings: async () => true,
    })
    await expect(missing.initialize()).rejects.toThrow("identity")
    expect(write).not.toHaveBeenCalled()
    const broken = new ResourceIdentityResolver({
      ...persistence,
      read: async () => ({ version: 1, secret: "broken" }),
      write,
    })
    await expect(broken.initialize()).rejects.toThrow("identity")
    expect(write).not.toHaveBeenCalled()
  })
  it("does not publish a new resource ID until its write succeeds", async () => {
    const r = new ResourceIdentityResolver(persistence)
    await r.initialize()
    const fail = new ResourceIdentityResolver({
      ...persistence,
      write: async () => {
        throw new Error("storage unavailable")
      },
    })
    await expect(fail.update("a", "1", material())).rejects.toThrow("storage unavailable")
    expect(fail.get("a", "1")).toBeUndefined()
    expect(writes).toBe(1)
  })
})
