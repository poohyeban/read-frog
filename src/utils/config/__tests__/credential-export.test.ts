import { describe, expect, it } from "vitest"
import { getObjectWithoutAPIKeys } from "../api"

describe("credential-free local export", () => {
  it("removes keys and custom authentication headers without mutating stored config", () => {
    const config = {
      providersConfig: [
        {
          name: "My API",
          apiKey: "test-secret",
          headers: { Authorization: "Bearer another-secret" },
        },
      ],
    }
    expect(getObjectWithoutAPIKeys(config)).toEqual({ providersConfig: [{ name: "My API" }] })
    expect(config.providersConfig[0]?.apiKey).toBe("test-secret")
    expect(config.providersConfig[0]?.headers.Authorization).toBe("Bearer another-secret")
  })

  it("fails closed if the input cannot be redacted", () => {
    const invalid = {
      get broken() {
        throw new Error("Unreadable config")
      },
    }
    expect(() => getObjectWithoutAPIKeys(invalid)).toThrow(
      "Could not remove credentials from configuration",
    )
  })
})
