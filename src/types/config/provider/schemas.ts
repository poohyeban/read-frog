import type {
  APIProviderTypes,
  DedicatedLLMProviderTypes,
  LLMProviderTypes,
  NonAPIProviderTypes,
  OpenAICompatibleLLMProviderTypes,
  ProtocolCompatibleLLMProviderTypes,
  TopLevelReasoningProviderTypes,
  TranslateProviderTypes,
} from "./constants"
import { z } from "zod"
import {
  AI_SDK_REASONING_VALUES,
  LLM_PROVIDER_MODELS,
  isCustomModelOnlyProvider,
} from "./constants"

/* ──────────────────────────────
  Providers config schema
  ────────────────────────────── */

// Helper function to create provider-specific model schema
function createProviderModelSchema<T extends LLMProviderTypes>(provider: T) {
  const models = LLM_PROVIDER_MODELS[provider]
  return z.object({
    model: z.enum(models),
    isCustomModel: isCustomModelOnlyProvider(provider) ? z.literal(true) : z.boolean(),
    customModel: z.string().nullable(),
  })
}

// Base schema without models
export const baseProviderConfigSchema = z.strictObject({
  id: z.string().nonempty(),
  name: z.string().nonempty(),
  description: z.string().optional(),
  enabled: z.boolean(),
})

export const baseAPIProviderConfigSchema = baseProviderConfigSchema.extend({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  temperature: z.number().min(0).optional(),
  providerOptions: z.record(z.string(), z.any()).optional(),
  headers: z.record(z.string(), z.any()).optional(),
})

export const baseOpenAICompatibleLLMProviderConfigSchema = baseAPIProviderConfigSchema.extend({
  baseURL: z.string(),
})

const topLevelReasoningConfigSchema = {
  reasoning: z.enum(AI_SDK_REASONING_VALUES).optional(),
}

const llmProviderConfigSchemaList = [
  baseOpenAICompatibleLLMProviderConfigSchema.extend({
    provider: z.literal("openai-compatible"),
    model: createProviderModelSchema<"openai-compatible">("openai-compatible"),
  }),

  baseAPIProviderConfigSchema.extend({
    provider: z.literal("openai"),
    model: createProviderModelSchema<"openai">("openai"),
    ...topLevelReasoningConfigSchema,
  }),

  baseAPIProviderConfigSchema.extend({
    provider: z.literal("google"),
    model: createProviderModelSchema<"google">("google"),
    ...topLevelReasoningConfigSchema,
  }),

  baseAPIProviderConfigSchema.extend({
    provider: z.literal("ollama"),
    model: createProviderModelSchema<"ollama">("ollama"),
  }),
] as const

const apiProviderConfigSchemaList = [...llmProviderConfigSchemaList] as const

export const providerConfigSchemaList = [
  ...apiProviderConfigSchemaList,
  baseProviderConfigSchema.extend({
    provider: z.literal("google-translate"),
  }),
] as const

export const llmProviderConfigItemSchema = z.discriminatedUnion(
  "provider",
  llmProviderConfigSchemaList,
)
export const apiProviderConfigItemSchema = z.discriminatedUnion(
  "provider",
  apiProviderConfigSchemaList,
)
export const providerConfigItemSchema = z.discriminatedUnion("provider", providerConfigSchemaList)

export const providersConfigSchema = z
  .array(providerConfigItemSchema)
  .superRefine((providers, ctx) => {
    const idSet = new Set<string>()
    providers.forEach((provider, index) => {
      if (idSet.has(provider.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate provider id "${provider.id}"`,
          path: [index, "id"],
        })
      }
      idSet.add(provider.id)
    })

    const nameSet = new Set<string>()
    providers.forEach((provider, index) => {
      if (nameSet.has(provider.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate provider name "${provider.name}"`,
          path: [index, "name"],
        })
      }
      nameSet.add(provider.name)
    })
  })
export type ProvidersConfig = z.infer<typeof providersConfigSchema>
export type ProviderConfig = ProvidersConfig[number]
export type NonAPIProviderConfig = Extract<ProviderConfig, { provider: NonAPIProviderTypes }>

export type APIProviderConfig = Extract<ProviderConfig, { provider: APIProviderTypes }>

export type LLMProviderConfig = Extract<ProviderConfig, { provider: LLMProviderTypes }>
export type TranslateProviderConfig = Extract<ProviderConfig, { provider: TranslateProviderTypes }>
export type OpenAICompatibleLLMProviderConfig = Extract<
  ProviderConfig,
  { provider: OpenAICompatibleLLMProviderTypes }
>

export type ProtocolCompatibleLLMProviderConfig = Extract<
  ProviderConfig,
  { provider: ProtocolCompatibleLLMProviderTypes }
>
export type DedicatedLLMProviderConfig = Extract<
  ProviderConfig,
  { provider: DedicatedLLMProviderTypes }
>
export type TopLevelReasoningProviderConfig = Extract<
  LLMProviderConfig,
  { provider: TopLevelReasoningProviderTypes }
>

/* ──────────────────────────────
  unified llm model config helpers
  ────────────────────────────── */

type ModelTuple = readonly [string, ...string[]] // 至少一个元素才能给 z.enum
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T preserves literal model tuple inference for z.enum.
function providerConfigSchema<T extends ModelTuple>(models: T) {
  return z.object({
    model: z.enum(models),
    isCustomModel: z.boolean(),
    customModel: z.string().nullable(),
  })
}

type SchemaShape<M extends Record<string, ModelTuple>> = {
  [K in keyof M]: ReturnType<typeof providerConfigSchema<M[K]>>
}

function buildProviderModelsSchema<M extends Record<string, ModelTuple>>(models: M) {
  return z.object(
    // Keep key names and types when building schema dynamically.
    (Object.keys(models) as (keyof M)[]).reduce((acc, key) => {
      acc[key] = providerConfigSchema(models[key])
      return acc
    }, {} as SchemaShape<M>),
  )
}

const {
  "openai-compatible": _openAICompatible,

  ...modelsWithSelectableDefaults
} = LLM_PROVIDER_MODELS
export const llmProviderModelsSchema = buildProviderModelsSchema(
  modelsWithSelectableDefaults,
).extend({
  "openai-compatible": z.object({
    model: z.enum(LLM_PROVIDER_MODELS["openai-compatible"]),
    isCustomModel: z.literal(true),
    customModel: z.string().nullable(),
  }),
})
export type LLMProviderModels = z.infer<typeof llmProviderModelsSchema>
