import { afterEach, describe, expect, it, vi } from "vitest"
import "../config"
// Warm config's module graph at collection time, which has no timeout. Each test
// still re-imports it after vi.resetModules(), but no longer pays the cold load
// inside its 5s budget.

describe("dEFAULT_CONFIG", () => {
  const originalCrypto = globalThis.crypto

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    })
    vi.resetModules()
  })

  it("defaults fresh hover translation off", async () => {
    const { DEFAULT_CONFIG } = await import("../config")

    expect(DEFAULT_CONFIG.pageTranslation.node.forceRetranslation).toBe(false)
  })
})
