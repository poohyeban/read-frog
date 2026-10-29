import type { TTSConfig } from "@/types/config/tts"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useAtomValue } from "jotai"
import { useRef, useState } from "react"
import { toastManager } from "@/components/ui/base-ui/toast"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { detectLanguage } from "@/utils/content/language"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { Sha256Hex } from "@/utils/hash"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { splitTextByUtf8Bytes } from "@/utils/tts-playback/chunk"

interface PlayAudioParams {
  text: string
  ttsConfig: TTSConfig

  forcedVoice?: string
  // A run nobody pressed for (a layout reading a field as the answer arrives)
  // fails without a toast; pressing the trigger tries again and reports it.
  quiet?: boolean
}

interface SynthesizedAudioChunk {
  audioBase64: string
  contentType: string
}

const TTS_ERROR_TOAST_ID = "tts-synthesize-error"

export function selectTTSVoice(
  ttsConfig: TTSConfig,
  detectedLanguage?: string | null,
  forcedVoice?: string,
): string {
  if (forcedVoice) {
    return forcedVoice
  }

  if (detectedLanguage && detectedLanguage in ttsConfig.languageVoices) {
    return ttsConfig.languageVoices[detectedLanguage] ?? ttsConfig.defaultVoice
  }

  return ttsConfig.defaultVoice
}

async function resolveVoiceForText(
  text: string,
  ttsConfig: TTSConfig,
  forcedVoice?: string,
): Promise<string> {
  if (forcedVoice) return forcedVoice
  return selectTTSVoice(ttsConfig, await detectLanguage(text, { minLength: 0 }))
}

export function useTextToSpeech() {
  const queryClient = useQueryClient()
  const providers = useAtomValue(configFieldsAtomMap.providersConfig)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentChunk, setCurrentChunk] = useState(0)
  const [totalChunks, setTotalChunks] = useState(0)
  const shouldStopRef = useRef(false)
  const activeRequestIdRef = useRef<string | null>(null)

  const stop = () => {
    shouldStopRef.current = true

    const activeRequestId = activeRequestIdRef.current
    activeRequestIdRef.current = null
    if (activeRequestId) {
      void sendMessage("cancelSpeech", { requestId: activeRequestId }).catch(() => {})
      void sendMessage("ttsPlaybackStop", { requestId: activeRequestId }).catch(() => {})
    }

    setIsPlaying(false)
    setCurrentChunk(0)
    setTotalChunks(0)
  }

  const playMutation = useMutation<void, Error, PlayAudioParams>({
    meta: {
      suppressToast: true,
    },
    mutationFn: async ({ text, ttsConfig, forcedVoice }) => {
      stop()
      shouldStopRef.current = false

      const requestId = getRandomUUID()
      activeRequestIdRef.current = requestId
      // A newer play() resets shouldStopRef, so a run still awaiting a fetch
      // must also check that it is still the active request; otherwise it
      // would resume, start its audio over the newer one and flip its state.
      const isSuperseded = () => shouldStopRef.current || activeRequestIdRef.current !== requestId
      try {
        await runPlayback(requestId, isSuperseded, {
          text,
          ttsConfig,

          forcedVoice,
        })
      } catch (error) {
        // A run the user already stopped or replaced reports nothing.
        if (isSuperseded()) return
        throw error
      }
    },
    onError: (error, variables) => {
      if (!variables.quiet) {
        toastManager.add({
          type: "error",
          title: i18n.t("speak.failedToGenerateSpeech"),
          id: TTS_ERROR_TOAST_ID,
          description: error.message,
        })
      }
      activeRequestIdRef.current = null
      setIsPlaying(false)
      setCurrentChunk(0)
      setTotalChunks(0)
    },
  })

  async function runPlayback(
    requestId: string,
    isSuperseded: () => boolean,
    { text, ttsConfig, forcedVoice }: PlayAudioParams,
  ) {
    const selectedVoice = await resolveVoiceForText(text, ttsConfig, forcedVoice)
    if (isSuperseded()) {
      return
    }
    const chunks = splitTextByUtf8Bytes(text)
    setTotalChunks(chunks.length)
    await sendMessage("ttsPlaybackPrepare")
    if (isSuperseded()) {
      return
    }

    const configHash = Sha256Hex(
      JSON.stringify({
        tts: ttsConfig,
        provider: providers.find((p) => p.id === ttsConfig.providerId),
      }),
    )
    const fetchChunkAudio = async (chunk: string) => {
      return queryClient.fetchQuery({
        queryKey: [
          "tts-audio",
          {
            text: chunk,
            voice: selectedVoice,
            rate: ttsConfig.rate,
            provider: Sha256Hex(
              JSON.stringify(providers.find((p) => p.id === ttsConfig.providerId)),
            ),
            model: ttsConfig.model,
            outputFormat: ttsConfig.outputFormat,
          },
        ],
        queryFn: () =>
          sendMessage("synthesizeSpeech", {
            text: chunk,
            voice: selectedVoice,
            requestId,
            configHash,
          }),
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 1000 * 60 * 10,
        retry: false,
        meta: {
          suppressToast: true,
        },
      })
    }

    const playChunk = async (audioChunk: SynthesizedAudioChunk): Promise<boolean> => {
      // isPlaying belongs to the active run; a superseded one leaves it alone.
      if (!isSuperseded()) setIsPlaying(true)
      try {
        const playbackResult = await sendMessage("ttsPlaybackStart", {
          requestId,
          audioBase64: audioChunk.audioBase64,
          contentType: audioChunk.contentType,
        })

        return playbackResult.ok
      } finally {
        if (activeRequestIdRef.current === requestId) setIsPlaying(false)
      }
    }

    for (let index = 0; index < chunks.length; index++) {
      if (isSuperseded()) {
        break
      }

      setCurrentChunk(index + 1)
      const currentAudioPromise = fetchChunkAudio(chunks[index]!)
      const nextAudioPromise =
        index + 1 < chunks.length
          ? fetchChunkAudio(chunks[index + 1]!).catch(() => undefined)
          : null
      const audioChunk = await currentAudioPromise

      if (isSuperseded()) {
        break
      }

      const didPlay = await playChunk(audioChunk)
      if (!didPlay || isSuperseded()) {
        break
      }

      if (nextAudioPromise) {
        await nextAudioPromise
      }
    }

    if (activeRequestIdRef.current === requestId) {
      activeRequestIdRef.current = null
      setCurrentChunk(0)
      setTotalChunks(0)
    }
  }

  // `options.surface` reports a play started from somewhere other than the
  // hook's own surface (a keyboard shortcut for the toolbar's reader).
  const play = (
    text: string,
    ttsConfig: TTSConfig,
    options?: {
      forcedVoice?: string

      quiet?: boolean
    },
  ) => {
    return playMutation.mutateAsync({
      text,
      ttsConfig,
      forcedVoice: options?.forcedVoice,
      quiet: options?.quiet,
    })
  }

  const isFetching = playMutation.isPending && !isPlaying

  return {
    play,
    stop,
    isFetching,
    isPlaying,
    currentChunk,
    totalChunks,
    error: playMutation.error,
  }
}
