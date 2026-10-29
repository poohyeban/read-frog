import { describe, expect, it } from "vitest"
import { getProviderHeaders } from "../headers"

describe("provider headers", () => {
  it("sends the user's own headers for a provider with none forced", () => {
    expect(getProviderHeaders({ "X-Test": "1" })).toEqual({
      "X-Test": "1",
    })
  })

  it("sends nothing when a provider with none forced has no configured headers", () => {
    expect(getProviderHeaders(undefined)).toBeUndefined()
    expect(getProviderHeaders({})).toBeUndefined()
  })

  it("filters empty and non-string header values", () => {
    expect(
      getProviderHeaders({
        "X-Empty": "",
        "X-Count": 1,
        "X-Test": "1",
      }),
    ).toEqual({
      "X-Test": "1",
    })
  })
})
