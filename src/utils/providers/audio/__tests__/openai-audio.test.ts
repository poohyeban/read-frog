import { createServer } from "node:http"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { getSpeechProvider, getTranscriptionProvider } from "../openai-audio"

const seen: { path: string; auth: string | undefined; cookie: string | undefined; body: string }[] =
  []
let mode = "ok"
let baseURL = ""
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  seen.push({
    path: req.url ?? "",
    auth: req.headers.authorization,
    cookie: req.headers.cookie,
    body: Buffer.concat(chunks).toString(),
  })
  if (mode === "redirect") {
    res.writeHead(302, { location: baseURL + "/unexpected" })
    res.end()
    return
  }
  if (mode === "error") {
    res.writeHead(401, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: req.headers.authorization } }))
    return
  }
  if (mode === "slow") return
  if (req.url?.endsWith("/speech")) {
    res.writeHead(200, { "content-type": mode === "html" ? "text/html" : "audio/mpeg" })
    res.end(mode === "empty" ? "" : Buffer.from([0x49, 0x44, 0x33, 0, 0, 0]))
    return
  }
  const segments = [
    {
      id: 0,
      seek: 0,
      start: mode === "bad-time" ? 2 : 0.25,
      end: 1.75,
      text: "Hello",
      tokens: [],
      temperature: 0,
      avg_logprob: 0,
      compression_ratio: 0,
      no_speech_prob: 0,
    },
  ]
  res.writeHead(200, { "content-type": "application/json" })
  res.end(
    JSON.stringify(
      mode === "invalid"
        ? { text: 42 }
        : { text: "Hello", language: "english", ...(mode === "text-only" ? {} : { segments }) },
    ),
  )
})
function config() {
  const c = structuredClone(DEFAULT_CONFIG)
  c.providersConfig = [
    {
      ...c.providersConfig.find((p) => p.provider === "openai")!,
      id: "audio-test",
      baseURL,
      apiKey: "test-private-key",
    },
  ]
  c.tts = { ...c.tts, providerId: "audio-test", model: "test-tts", defaultVoice: "test-voice" }
  c.transcription = {
    ...c.transcription,
    providerId: "audio-test",
    model: "test-asr",
    language: "en",
  }
  return c
}
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw Error("Missing test server")
  baseURL = `http://127.0.0.1:${addr.port}/v1`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
})
beforeEach(() => {
  seen.length = 0
  mode = "ok"
})
const audio = () => ({
  audio: new Blob(["RIFF audio fixture"], { type: "audio/wav" }),
  format: "audio/wav" as const,
})
describe("OpenAI audio protocol over a local HTTP endpoint", () => {
  it("sends model, voice, speed and authorization only to the selected speech endpoint", async () => {
    const result = await getSpeechProvider(config()).synthesize({
      text: "Hello",
      voice: "test-voice",
      speed: 1.25,
    })
    expect(result.contentType).toBe("audio/mpeg")
    expect(atob(result.audioBase64)).toMatch(/^ID3/)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      path: "/v1/audio/speech",
      auth: "Bearer test-private-key",
      cookie: undefined,
    })
    expect(JSON.parse(seen[0]!.body)).toMatchObject({
      model: "test-tts",
      input: "Hello",
      voice: "test-voice",
      speed: 1.25,
      response_format: "mp3",
    })
  })
  it("rejects a response whose audio format does not match the selected format", async () => {
    const c = config()
    c.tts.outputFormat = "wav"
    await expect(
      getSpeechProvider(c).synthesize({ text: "Hello", voice: "test" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
  })
  it("sends multipart audio and converts validated seconds to native subtitle milliseconds", async () => {
    const result = await getTranscriptionProvider(config()).transcribe(audio())
    expect(result).toMatchObject({
      text: "Hello",
      sourceLanguage: "en",
      segments: [{ id: "asr-0", text: "Hello", start: 250, end: 1750 }],
    })
    expect(seen[0]?.path).toBe("/v1/audio/transcriptions")
    for (const field of [
      'name="model"',
      "test-asr",
      'filename="audio.wav"',
      'name="language"',
      'name="response_format"',
      "verbose_json",
    ])
      expect(seen[0]?.body).toContain(field)
  })
  it("keeps text-only ASR responses without inventing timestamps", async () => {
    mode = "text-only"
    expect((await getTranscriptionProvider(config()).transcribe(audio())).segments).toEqual([])
  })
  it("requires explicit service selection and never calls a default service", () => {
    expect(() => getSpeechProvider(DEFAULT_CONFIG)).toThrow(/Configure/)
    expect(() => getTranscriptionProvider(DEFAULT_CONFIG)).toThrow(/Configure/)
    expect(seen).toEqual([])
  })
  it("rejects redirects instead of forwarding credentials", async () => {
    mode = "redirect"
    await expect(
      getSpeechProvider(config()).synthesize({ text: "Hello", voice: "v" }),
    ).rejects.toMatchObject({ code: "NETWORK" })
    expect(seen).toHaveLength(1)
  })
  it("does not expose server-reflected secrets in HTTP errors", async () => {
    mode = "error"
    await expect(
      getSpeechProvider(config()).synthesize({ text: "Hello", voice: "v" }),
    ).rejects.toMatchObject({ code: "HTTP", message: "Audio service returned HTTP 401." })
  })
  it.each(["html", "empty"])("rejects %s speech responses", async (value) => {
    mode = value
    await expect(
      getSpeechProvider(config()).synthesize({ text: "Hello", voice: "v" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
  })
  it.each(["invalid", "bad-time"])("rejects %s transcription responses", async (value) => {
    mode = value
    await expect(getTranscriptionProvider(config()).transcribe(audio())).rejects.toThrow(
      /response/i,
    )
  })
  it("supports cancellation without another request", async () => {
    mode = "slow"
    const controller = new AbortController()
    const pending = getTranscriptionProvider(config()).transcribe({
      ...audio(),
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" })
  })
  it("reports timeout", async () => {
    mode = "slow"
    const c = config()
    c.tts.timeoutMs = 20
    await expect(
      getSpeechProvider(c).synthesize({ text: "Hello", voice: "v" }),
    ).rejects.toMatchObject({ code: "TIMEOUT" })
  })
  it("rejects empty audio and invalid speed before network access", async () => {
    await expect(
      getTranscriptionProvider(config()).transcribe({ ...audio(), audio: new Blob([]) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    await expect(
      getSpeechProvider(config()).synthesize({ text: "Hello", voice: "v", speed: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    expect(seen).toEqual([])
  })
})
