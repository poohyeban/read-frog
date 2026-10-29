import { z } from "zod"

const diagnosticSchema = z.object({
  requestId: z.uuid().optional(),
  port: z.enum(["stream-text", "stream-structured-object", "unknown"]),
  phase: z.enum(["connect", "send", "start", "request", "disconnect"]),
  errorType: z
    .enum([
      "AI_APICallError",
      "AI_RetryError",
      "AI_NoOutputGeneratedError",
      "AI_NoObjectGeneratedError",
      "AI_TypeValidationError",
      "AI_JSONParseError",
      "ProviderSetupError",
      "TypeError",
      "unknown",
    ])
    .default("unknown"),
  httpStatus: z.number().int().min(100).max(599).optional(),
  responseFormat: z.enum(["text", "json_object", "json_schema"]).optional(),
  providerCode: z
    .enum([
      "invalid_request_error",
      "invalid_request",
      "invalid_api_key",
      "authentication_error",
      "model_not_found",
      "rate_limit_exceeded",
      "insufficient_quota",
      "context_length_exceeded",
    ])
    .optional(),
  parameter: z
    .enum([
      "response_format",
      "response_format.type",
      "model",
      "temperature",
      "messages",
      "max_tokens",
      "max_completion_tokens",
    ])
    .optional(),
  reason: z
    .enum([
      "response_format_rejected",
      "no_receiver",
      "context_invalidated",
      "port_closed",
      "network_error",
      "stream_protocol_error",
      "output_validation_failed",
      "invalid_request",
    ])
    .optional(),
})

export type StreamDiagnostic = z.infer<typeof diagnosticSchema>

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function allowed<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | undefined {
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

/** Only fixed classifications and HTTP status survive. Never copy remote free text. */
export function createStreamDiagnostic(
  error: unknown,
  context: { requestId: string; port: string; phase: StreamDiagnostic["phase"] },
): StreamDiagnostic {
  const diagnostic: StreamDiagnostic = {
    requestId: allowed(diagnosticSchema.shape.requestId, context.requestId),
    port: allowed(diagnosticSchema.shape.port, context.port) ?? "unknown",
    phase: context.phase,
    errorType: "unknown",
  }
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth++) {
    seen.add(current)
    const source = record(current)
    const errorType = allowed(diagnosticSchema.shape.errorType, source.name)
    if (errorType && errorType !== "unknown") diagnostic.errorType = errorType
    diagnostic.httpStatus ??= allowed(diagnosticSchema.shape.httpStatus, source.statusCode)
    diagnostic.responseFormat ??= allowed(
      diagnosticSchema.shape.responseFormat,
      record(record(source.requestBodyValues).response_format).type,
    )
    diagnostic.reason ??= allowed(diagnosticSchema.shape.reason, source.code)

    // Bodies may reflect credentials, prompts, URLs or model output. Extract only
    // known enums, and classify message patterns without retaining their text.
    let remote: Record<string, unknown> = {}
    if (typeof source.responseBody === "string" && source.responseBody.length <= 65_536) {
      try {
        remote = record(record(JSON.parse(source.responseBody)).error)
      } catch {
        /* Not JSON. */
      }
    }
    diagnostic.providerCode ??= allowed(
      diagnosticSchema.shape.providerCode,
      remote.code ?? remote.type,
    )
    diagnostic.parameter ??= allowed(diagnosticSchema.shape.parameter, remote.param)
    const message = [
      source.message,
      remote.message,
      typeof current === "string" ? current : undefined,
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.slice(0, 4096))
      .join(" ")
      .toLowerCase()
    if (
      /response_format|json_schema/.test(message) &&
      /unsupported|not support|invalid|unknown variant/.test(message)
    ) {
      diagnostic.reason = "response_format_rejected"
    } else if (message.includes("receiving end does not exist")) {
      diagnostic.reason = "no_receiver"
    } else if (message.includes("extension context invalidated")) {
      diagnostic.reason = "context_invalidated"
    } else if (/port.*(closed|disconnect)|(closed|disconnect).*port/.test(message)) {
      diagnostic.reason = "port_closed"
    } else if (/failed to fetch|fetch failed|networkerror/.test(message)) {
      diagnostic.reason = "network_error"
    }
    current = source.cause
  }
  return diagnostic
}

/** Also validate port-delivered diagnostics; never log a raw error or payload. */
export function reportStreamDiagnostic(value: unknown, scope: "background" | "content") {
  const result = diagnosticSchema.safeParse(value)
  if (!result.success) return
  // Production console only: the general dev logger is deliberately disabled in releases.
  // eslint-disable-next-line no-console
  console.error(
    "[Read Frog Lite][stream]",
    JSON.stringify({ diagnosticVersion: 1, scope, ...result.data }),
  )
}
