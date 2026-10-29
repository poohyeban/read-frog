import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Output, streamText } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createStreamDiagnostic, reportStreamDiagnostic } from "../stream-diagnostics"

const context = {
  requestId: "6c71ddf9-3824-4aa2-ae3e-6b043467cefc",
  port: "stream-structured-object",
  phase: "request",
} as const

afterEach(() => vi.restoreAllMocks())

describe("production stream diagnostics", () => {
  it("reports a real SDK HTTP rejection without exposing reflected credentials or text", async () => {
    const secret = "fixture-secret-do-not-log"
    const selectedText = "private selected sentence"
    const requests: unknown[] = []
    const provider = createOpenAICompatible({
      name: "fixture",
      baseURL: "https://fixture.invalid/v1",
      apiKey: secret,
      supportsStructuredOutputs: true,
      fetch: async (_input, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected a JSON request body")
        requests.push(JSON.parse(init.body))
        return new Response(
          JSON.stringify({
            error: {
              message: `Unsupported response_format json_schema; ${secret}; ${selectedText}`,
              type: "invalid_request_error",
              param: "response_format",
              extra: secret,
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        )
      },
    })
    let failure: unknown
    const result = streamText({
      model: provider.languageModel("deepseek-flash"),
      prompt: selectedText,
      output: Output.object({ schema: z.object({ meaning: z.string() }) }),
      maxRetries: 0,
      onError: ({ error }) => {
        failure = error
      },
    })
    for await (const part of result.stream) {
      if (part.type === "error") failure = part.error
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ response_format: { type: "json_schema" } })
    const diagnostic = createStreamDiagnostic(failure, context)
    expect(diagnostic).toMatchObject({
      ...context,
      errorType: "AI_APICallError",
      httpStatus: 400,
      responseFormat: "json_schema",
      providerCode: "invalid_request_error",
      parameter: "response_format",
      reason: "response_format_rejected",
    })
    const log = vi.spyOn(console, "error")
    reportStreamDiagnostic(
      { ...diagnostic, responseBody: secret, prompt: selectedText },
      "background",
    )
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(log.mock.calls)).not.toContain(selectedText)
    expect(JSON.parse(log.mock.calls[0]![1] as string)).toMatchObject({
      scope: "background",
      httpStatus: 400,
    })
  })

  it("follows retry causes, ignores arbitrary strings and terminates on cyclic causes", () => {
    const cause = { name: "AI_APICallError", statusCode: 429, cause: {} }
    cause.cause = cause
    expect(createStreamDiagnostic({ name: "AI_RetryError", cause }, context)).toMatchObject({
      errorType: "AI_APICallError",
      httpStatus: 429,
    })
    const untrusted = "secret echoed by provider"
    const diagnostic = createStreamDiagnostic(
      {
        name: untrusted,
        statusCode: 999,
        code: untrusted,
        requestBodyValues: { response_format: { type: untrusted } },
        responseBody: JSON.stringify({
          error: { code: untrusted, param: untrusted, message: untrusted },
        }),
      },
      { ...context, requestId: untrusted, port: untrusted },
    )
    expect(JSON.stringify(diagnostic)).not.toContain(untrusted)
    expect(diagnostic).toMatchObject({ errorType: "unknown", port: "unknown" })
    const log = vi.spyOn(console, "error")
    reportStreamDiagnostic({ ...diagnostic, parameter: untrusted }, "content")
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    ["Could not establish connection. Receiving end does not exist.", "no_receiver"],
    ["Extension context invalidated.", "context_invalidated"],
    ["Attempting to use a disconnected port object", "port_closed"],
    ["Failed to fetch", "network_error"],
  ])("classifies %s without forwarding raw text", (message, reason) => {
    expect(createStreamDiagnostic(new Error(message), context).reason).toBe(reason)
  })
})
