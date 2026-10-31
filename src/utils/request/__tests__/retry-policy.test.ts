import { describe, expect, it, vi } from "vitest"
import {
  attachRequestErrorMeta,
  defaultRequestRetryPolicy,
  getRequestErrorMeta,
  getRetryAfterMs,
  isRateLimitRequestError,
} from "../retry-policy"
const context = {
  retryCount: 0,
  maxRetries: 2,
  baseRetryDelayMs: 100,
  maxRetryDelayMs: 30000,
  now: 0,
}
const http = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode })
describe("one finite attempt policy", () => {
  it.each([400, 401, 403, 404, 422])("HTTP %s fails this task only", (status) => {
    expect(defaultRequestRetryPolicy.decide(http(status), context)).toEqual({ action: "fail" })
  })
  it.each([408, 409, 500, 503])("HTTP %s permits bounded retries", (status) => {
    expect(defaultRequestRetryPolicy.decide(http(status), context).action).toBe("retry")
    expect(defaultRequestRetryPolicy.decide(http(status), { ...context, retryCount: 2 })).toEqual({
      action: "fail",
    })
  })
  it("does not grant a separate 429 allowance", () => {
    expect(defaultRequestRetryPolicy.decide(http(429), context).action).toBe("pause-and-retry")
    expect(defaultRequestRetryPolicy.decide(http(429), { ...context, retryCount: 2 })).toEqual({
      action: "fail",
    })
  })
  it("honors Retry-After within the configured delay limit, otherwise ends this task", () => {
    const error = attachRequestErrorMeta(http(429), { responseHeaders: { "retry-after": "20" } })
    expect(defaultRequestRetryPolicy.decide(error, context)).toEqual({
      action: "pause-and-retry",
      pauseMs: 20000,
    })
    const later = attachRequestErrorMeta(http(429), { retryAfterMs: 86400000 })
    expect(defaultRequestRetryPolicy.decide(later, context)).toEqual({ action: "fail" })
    // The physical scheduler still receives the complete server cooldown.
    expect(getRetryAfterMs(getRequestErrorMeta(later))).toBe(86400000)
  })
  it("applies exponential backoff and a finite maximum", () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const error = new Error("network error")
    expect(defaultRequestRetryPolicy.decide(error, context)).toEqual({
      action: "retry",
      delayMs: 100,
    })
    expect(defaultRequestRetryPolicy.decide(error, { ...context, retryCount: 1 })).toEqual({
      action: "retry",
      delayMs: 200,
    })
    expect(
      defaultRequestRetryPolicy.decide(error, { ...context, retryCount: 1, maxRetryDelayMs: 150 }),
    ).toEqual({ action: "retry", delayMs: 150 })
    vi.restoreAllMocks()
  })
  it("respects explicit permanent/format errors and trusted adapter metadata", () => {
    const error = attachRequestErrorMeta(new Error("format mismatch"), { isRetryable: false })
    expect(defaultRequestRetryPolicy.decide(error, context)).toEqual({ action: "fail" })
    const denied = attachRequestErrorMeta(http(409), { kind: "access-denied" })
    expect(defaultRequestRetryPolicy.decide(denied, context)).toEqual({ action: "fail" })
    expect(isRateLimitRequestError(denied)).toBe(false)
  })
  it("reads Headers, nested response status, millisecond and HTTP-date delays", () => {
    expect(
      getRequestErrorMeta({
        response: {
          status: 429,
          headers: new Headers({ "retry-after-ms": "1234", "retry-after": "5" }),
        },
      }),
    ).toMatchObject({ statusCode: 429, retryAfterMs: 1234, kind: "rate-limit" })
    expect(
      getRetryAfterMs({ responseHeaders: { "Retry-After": "Thu, 01 Jan 1970 00:00:10 GMT" } }, 0),
    ).toBe(10000)
    expect(getRetryAfterMs({ responseHeaders: { "retry-after": "invalid" } })).toBeUndefined()
  })
})
