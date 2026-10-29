import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getProviderConnectionURL } from "../connection-url"

describe("getProviderConnectionURL", () => {
  it("reads the Base URL from other API provider configs", () => {
    expect(getProviderConnectionURL(DEFAULT_PROVIDER_CONFIG["openai-compatible"])).toBe(
      "https://api.example.com/v1",
    )
    expect(getProviderConnectionURL(DEFAULT_PROVIDER_CONFIG.openai)).toBeUndefined()
  })
})
