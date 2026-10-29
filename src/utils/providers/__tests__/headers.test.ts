import { describe, expect, it } from "vitest"
import { getProviderHeadersWithOverride } from "../headers"

describe("provider headers", () => {
  it("sends the user's own headers for a provider with none forced", () => {
    expect(getProviderHeadersWithOverride("openai", { "X-Test": "1" })).toEqual({
      "X-Test": "1",
    })
  })

  it("sends nothing when a provider with none forced has no configured headers", () => {
    expect(getProviderHeadersWithOverride("openai", undefined)).toBeUndefined()
    expect(getProviderHeadersWithOverride("openai", {})).toBeUndefined()
  })

  it("filters empty and non-string header values", () => {
    expect(
      getProviderHeadersWithOverride("openai", {
        "X-Empty": "",
        "X-Count": 1,
        "X-Test": "1",
      }),
    ).toEqual({
      "X-Test": "1",
    })
  })
})
