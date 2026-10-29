// @vitest-environment jsdom
import type { ReactNode } from "react"
import type { TTSConfig } from "@/types/config/tts"
import type { DetectLanguageOptions } from "@/utils/content/language"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"

const sendMessageMock = vi.fn<(type: string, data?: any) => Promise<any>>()
const detectLanguageMock =
  vi.fn<(text: string, options?: DetectLanguageOptions) => Promise<string>>()

vi.mock("@/utils/message", () => ({
  sendMessage: (type: string, data?: any) => sendMessageMock(type, data),
}))
vi.mock("@/utils/content/language", () => ({
  detectLanguage: (text: string, options?: DetectLanguageOptions) =>
    detectLanguageMock(text, options),
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: vi.fn<(options: unknown) => void>() },
}))

const { useTextToSpeech } = await import("../use-text-to-speech")

const ttsConfig: TTSConfig = {
  providerId: "test",
  model: "test",
  timeoutMs: 120000,
  outputFormat: "mp3",
  defaultVoice: "en-US-DavisNeural",
  languageVoices: {},
  rate: 0,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((r, j) => {
    resolve = r
    reject = j
  })
  return { promise, resolve, reject }
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient()
  return (
    <QueryClientProvider client={queryClient}>
      <Provider store={createStore()}>{children}</Provider>
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("useTextToSpeech superseded runs", () => {
  it("never starts audio for a run replaced while its audio was still being fetched", async () => {
    // Run A is past voice detection and waiting on its audio; run B starts
    // meanwhile and plays. B's stop() resets shouldStopRef, so A must also
    // notice it is no longer the active request.
    const slowFetch = deferred<{ ok: true; audioBase64: string; contentType: string }>()
    detectLanguageMock.mockResolvedValue("eng")
    const started: string[] = []
    sendMessageMock.mockImplementation(async (type, data) => {
      if (type === "synthesizeSpeech") {
        return data.text === "A"
          ? slowFetch.promise
          : { ok: true, audioBase64: data.text, contentType: "audio/mpeg" }
      }
      if (type === "ttsPlaybackStart") {
        started.push(data.audioBase64)
        return { ok: true }
      }
      return undefined
    })

    const { result } = renderHook(() => useTextToSpeech(), { wrapper })

    let runA!: Promise<void>
    act(() => {
      runA = result.current.play("A", ttsConfig)
    })
    await waitFor(() =>
      expect(
        sendMessageMock.mock.calls.some(
          ([type, data]) => type === "synthesizeSpeech" && data.text === "A",
        ),
      ).toBe(true),
    )
    expect(detectLanguageMock).toHaveBeenCalledWith("A", expect.objectContaining({ minLength: 0 }))
    await act(async () => {
      await result.current.play("B", ttsConfig)
    })
    expect(started).toEqual(["B"])

    await act(async () => {
      slowFetch.resolve({ ok: true, audioBase64: "A", contentType: "audio/mpeg" })
      await runA
    })
    expect(started).toEqual(["B"])
    await waitFor(() => expect(result.current.isPlaying).toBe(false))
    expect(result.current.isFetching).toBe(false)
  })

  it("reports no error for a replaced run whose fetch fails", async () => {
    const slowFetch = deferred<{ audioBase64: string; contentType: string }>()
    detectLanguageMock.mockResolvedValue("eng")
    sendMessageMock.mockImplementation(async (type, data) => {
      if (type === "synthesizeSpeech") {
        return data.text === "A"
          ? slowFetch.promise
          : { ok: true, audioBase64: data.text, contentType: "audio/mpeg" }
      }
      if (type === "ttsPlaybackStart") return { ok: true }
      return undefined
    })
    const { toastManager } = await import("@/components/ui/base-ui/toast")

    const { result } = renderHook(() => useTextToSpeech(), { wrapper })
    let runA!: Promise<void>
    act(() => {
      runA = result.current.play("A", ttsConfig)
    })
    await waitFor(() =>
      expect(
        sendMessageMock.mock.calls.some(
          ([type, data]) => type === "synthesizeSpeech" && data.text === "A",
        ),
      ).toBe(true),
    )
    await act(async () => {
      await result.current.play("B", ttsConfig)
    })
    await act(async () => {
      slowFetch.reject(new Error("offline"))
      await runA.catch(() => {})
    })
    expect(toastManager.add).not.toHaveBeenCalled()
  })
})

describe("useTextToSpeech failures", () => {
  it("reports a failed run with a toast, unless it is a quiet one nobody pressed for", async () => {
    detectLanguageMock.mockResolvedValue("eng")
    sendMessageMock.mockImplementation(async (type) =>
      type === "synthesizeSpeech" ? Promise.reject(new Error("offline")) : undefined,
    )
    const { toastManager } = await import("@/components/ui/base-ui/toast")
    const { result } = renderHook(() => useTextToSpeech(), { wrapper })

    await act(async () => {
      await expect(result.current.play("A", ttsConfig, { quiet: true })).rejects.toThrow("offline")
    })
    expect(toastManager.add).not.toHaveBeenCalled()

    await act(async () => {
      await expect(result.current.play("B", ttsConfig)).rejects.toThrow("offline")
    })
    expect(toastManager.add).toHaveBeenCalledOnce()
  })
})

it("cancels an unmounted owner and ignores late synthesized audio", async () => {
  const pending = deferred<{ audioBase64: string; contentType: string }>()
  detectLanguageMock.mockResolvedValue("eng")
  sendMessageMock.mockImplementation(async (type) => {
    if (type === "synthesizeSpeech") return pending.promise
    return undefined
  })
  const { result, unmount } = renderHook(() => useTextToSpeech(), { wrapper })
  let playback!: Promise<void>
  act(() => {
    playback = result.current.play("Pending audio", ttsConfig)
  })
  await waitFor(() =>
    expect(sendMessageMock).toHaveBeenCalledWith("synthesizeSpeech", expect.anything()),
  )
  const request = sendMessageMock.mock.calls.find(([type]) => type === "synthesizeSpeech")![1]
  unmount()
  expect(sendMessageMock).toHaveBeenCalledWith("cancelSpeech", { requestId: request.requestId })
  expect(sendMessageMock).toHaveBeenCalledWith("ttsPlaybackStop", { requestId: request.requestId })
  await act(async () => {
    pending.resolve({ audioBase64: "late", contentType: "audio/mpeg" })
    await playback
  })
  expect(sendMessageMock.mock.calls.some(([type]) => type === "ttsPlaybackStart")).toBe(false)
})
