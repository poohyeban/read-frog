import { getLocalConfig } from "@/utils/config/storage"
import { Sha256Hex } from "@/utils/hash"
import { onMessage } from "@/utils/message"
import { getSpeechProvider } from "@/utils/providers/audio/openai-audio"

export function setupSpeechHandlers() {
  const requests = new Map<string, Set<AbortController>>()
  onMessage("synthesizeSpeech", async ({ data }) => {
    const controller = new AbortController()
    const controllers = requests.get(data.requestId) ?? new Set<AbortController>()
    controllers.add(controller)
    requests.set(data.requestId, controllers)
    try {
      const config = await getLocalConfig()
      controller.signal.throwIfAborted()
      if (!config) throw new Error("Configure a speech provider in settings.")
      const configHash = Sha256Hex(
        JSON.stringify({
          tts: config.tts,
          provider: config.providersConfig.find((p) => p.id === config.tts.providerId),
        }),
      )
      if (configHash !== data.configHash)
        throw new Error("Speech settings changed. Start playback again.")
      return await getSpeechProvider(config).synthesize({
        text: data.text,
        voice: data.voice,
        speed: (100 + config.tts.rate) / 100,
        signal: controller.signal,
      })
    } finally {
      controllers.delete(controller)
      if (!controllers.size) requests.delete(data.requestId)
    }
  })
  onMessage("cancelSpeech", async ({ data }) => {
    for (const controller of requests.get(data.requestId) ?? []) controller.abort()
    requests.delete(data.requestId)
  })
}
