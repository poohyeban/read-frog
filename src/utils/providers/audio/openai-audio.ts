import type { SpeechProvider, TranscriptionProvider } from "./types"
import type { Config } from "@/types/config/config"
import { createOpenAI } from "@ai-sdk/openai"
import { z } from "zod"
import { getProviderHeaders } from "../headers"
import { AudioServiceError } from "./types"

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const segmentSchema = z
  .object({
    text: z.string(),
    startSecond: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER / 1000),
    endSecond: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER / 1000),
  })
  .refine((s) => s.endSecond >= s.startSecond, "Invalid subtitle time range")

function service(config: Config, capability: "tts" | "transcription") {
  const settings = config[capability]
  const provider = config.providersConfig.find((p) => p.id === settings.providerId && p.enabled)
  if (
    !provider ||
    !["openai", "openai-compatible"].includes(provider.provider) ||
    !settings.model.trim()
  )
    throw new AudioServiceError(
      "NOT_CONFIGURED",
      "Configure an OpenAI-compatible audio provider and model in settings.",
    )
  let baseURL: URL
  try {
    baseURL = new URL(
      provider.baseURL || (provider.provider === "openai" ? "https://api.openai.com/v1" : ""),
    )
  } catch {
    throw new AudioServiceError("NOT_CONFIGURED", "Set a valid audio service Base URL.")
  }
  if (
    !["http:", "https:"].includes(baseURL.protocol) ||
    baseURL.username ||
    baseURL.password ||
    baseURL.search ||
    baseURL.hash
  )
    throw new AudioServiceError(
      "NOT_CONFIGURED",
      "Audio Base URL must be HTTP(S), without embedded credentials, query or fragment.",
    )
  const secureFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, credentials: "omit", redirect: "error" })
    const reader = response.body?.getReader()
    if (!reader)
      throw new AudioServiceError("INVALID_RESPONSE", "Audio service returned an empty body.")
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_AUDIO_BYTES)
          throw new AudioServiceError("INVALID_RESPONSE", "Audio service response exceeds 25 MiB.")
        chunks.push(chunk.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    }
    if (!response.ok)
      throw new AudioServiceError("HTTP", `Audio service returned HTTP ${response.status}.`)
    const type = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? ""
    if (
      capability === "tts"
        ? !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"].includes(type)
        : type !== "application/json"
    )
      throw new AudioServiceError(
        "INVALID_RESPONSE",
        "Audio service returned an unexpected Content-Type.",
      )
    if (!size)
      throw new AudioServiceError("INVALID_RESPONSE", "Audio service returned an empty body.")
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new Response(bytes, { status: response.status, headers: response.headers })
  }
  return {
    settings,
    sdk: createOpenAI({
      baseURL: baseURL.toString().replace(/\/$/, ""),
      apiKey: provider.apiKey ?? "",
      headers: getProviderHeaders(provider.headers),
      fetch: secureFetch,
    }),
  }
}
async function request<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    combined.throwIfAborted()
    return await run(combined)
  } catch (error) {
    if (signal?.aborted) throw new AudioServiceError("CANCELLED", "Audio request cancelled.")
    if (timeout.aborted) throw new AudioServiceError("TIMEOUT", "Audio service timed out.")
    if (error instanceof AudioServiceError) throw error
    if (
      error instanceof z.ZodError ||
      (error instanceof Error &&
        (/validation|invalid.*response/i.test(error.name) ||
          (error.cause instanceof Error && /validation|jsonparse/i.test(error.cause.name))))
    )
      throw new AudioServiceError("INVALID_RESPONSE", "Audio service returned an invalid response.")
    // SDK errors may contain request bodies or a server's reflected Authorization value.
    throw new AudioServiceError(
      "NETWORK",
      "Audio service request failed. Check the endpoint, model and protocol.",
    )
  }
}
function toBase64(bytes: Uint8Array) {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
export function getSpeechProvider(config: Config): SpeechProvider {
  const { sdk } = service(config, "tts")
  const settings = config.tts
  return {
    synthesize: ({ text, voice, speed = 1, signal }) =>
      request(settings.timeoutMs, signal, async (abortSignal) => {
        if (
          !text.trim() ||
          text.length > 10000 ||
          !voice.trim() ||
          !Number.isFinite(speed) ||
          speed < 0.25 ||
          speed > 4
        )
          throw new AudioServiceError(
            "INVALID_INPUT",
            "Speech requires text, a voice and speed between 0.25 and 4.",
          )
        const result = await sdk
          .speech(settings.model)
          .doGenerate({ text, voice, speed, outputFormat: settings.outputFormat, abortSignal })
        const bytes =
          typeof result.audio === "string"
            ? Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0))
            : result.audio
        if (!bytes.byteLength)
          throw new AudioServiceError("INVALID_RESPONSE", "Speech service returned no audio.")
        return {
          audioBase64: toBase64(bytes),
          contentType: settings.outputFormat === "wav" ? "audio/wav" : "audio/mpeg",
        }
      }),
  }
}
export function getTranscriptionProvider(config: Config): TranscriptionProvider {
  const { sdk } = service(config, "transcription")
  const settings = config.transcription
  return {
    transcribe: ({ audio, format, language, signal }) =>
      request(settings.timeoutMs, signal, async (abortSignal) => {
        if (
          !audio.size ||
          audio.size > MAX_AUDIO_BYTES ||
          ![
            "audio/wav",
            "audio/mpeg",
            "audio/mp4",
            "audio/webm",
            "audio/ogg",
            "audio/flac",
          ].includes(format)
        )
          throw new AudioServiceError(
            "INVALID_INPUT",
            "Provide an audio file of at most 25 MiB in a supported format.",
          )
        const bytes = new Uint8Array(await audio.arrayBuffer())
        abortSignal.throwIfAborted()
        const result = await sdk.transcription(settings.model).doGenerate({
          audio: bytes,
          mediaType: format,
          abortSignal,
          providerOptions: {
            openai: {
              responseFormat: settings.responseFormat,
              ...(language || settings.language ? { language: language || settings.language } : {}),
            },
          },
        })
        const parsed = z
          .object({
            text: z.string(),
            segments: z.array(segmentSchema),
            language: z.string().optional(),
          })
          .parse(result)
        if (!parsed.text.trim())
          throw new AudioServiceError("INVALID_RESPONSE", "Transcription service returned no text.")
        return {
          text: parsed.text,
          sourceLanguage: parsed.language,
          segments: parsed.segments.map((s, index) => ({
            id: `asr-${index}`,
            sourceLanguage: parsed.language,
            text: s.text,
            start: s.startSecond * 1000,
            end: s.endSecond * 1000,
          })),
        }
      }),
  }
}
