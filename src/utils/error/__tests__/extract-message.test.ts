import { describe, expect, it } from "vitest"
import { extractAISDKErrorMessage, extractErrorMessage } from "../extract-message"

describe("credential-safe API errors", () => {
  it("never renders remote errors, reflected keys, or response bodies", async () => {
    const secret = "test-private-credential"
    for (const error of [
      secret,
      new Error(secret),
      { message: secret, responseBody: secret, text: secret },
      { statusCode: 401, message: secret },
    ]) {
      expect(extractAISDKErrorMessage(error)).not.toContain(secret)
    }
    expect(extractAISDKErrorMessage({ statusCode: 429, message: secret })).toContain("HTTP 429")
    expect(
      await extractErrorMessage(new Response(secret, { status: 401, statusText: secret })),
    ).not.toContain(secret)
  })
})
