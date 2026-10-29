import { z } from "zod"

// Audio models share the existing endpoint/key registry, with independent model choices.
export const audioServiceSchema = z.object({
  providerId: z.string().default(""),
  model: z.string().trim().default(""),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
})
export const ttsConfigSchema = audioServiceSchema
  .extend({
    defaultVoice: z.string().trim().default(""),
    languageVoices: z.record(z.string(), z.string().trim().min(1)).default({}),
    rate: z.number().min(-75).max(300).default(0),
    outputFormat: z.enum(["mp3", "wav"]).default("mp3"),
  })
  .default({
    providerId: "",
    model: "",
    timeoutMs: 120000,
    defaultVoice: "",
    languageVoices: {},
    rate: 0,
    outputFormat: "mp3",
  })
export const transcriptionConfigSchema = audioServiceSchema
  .extend({
    language: z.string().trim().default(""),
    responseFormat: z.enum(["json", "verbose_json"]).default("verbose_json"),
  })
  .default({
    providerId: "",
    model: "",
    timeoutMs: 120000,
    language: "",
    responseFormat: "verbose_json",
  })
export type TTSConfig = z.infer<typeof ttsConfigSchema>
export type TranscriptionConfig = z.infer<typeof transcriptionConfigSchema>
