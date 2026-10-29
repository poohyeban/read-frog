import { langCodeISO6393Schema, langLevel } from "@read-frog/definitions"
import { z } from "zod"
import { BUILT_IN_ACTION_IDS, BUILT_IN_ACTION_KEYS } from "@/utils/constants/custom-action"
import { FEATURE_KEYS, FEATURE_PROVIDER_DEFS } from "@/utils/constants/feature-providers"
import { DEFAULT_VIDEO_SUBTITLES_CONFIG } from "@/utils/constants/restored-config"
import {
  DEFAULT_INPUT_TRANSLATION_CONFIG,
  DEFAULT_FLOATING_BUTTON_CONFIG,
} from "@/utils/constants/restored-config"
import {
  MAX_SELECTION_OVERLAY_OPACITY,
  MIN_SELECTION_OVERLAY_OPACITY,
} from "@/utils/constants/selection"
import {
  doesProviderSupportsCapability,
  getProviderIdsForCapability,
} from "@/utils/providers/provider-registry"
import { normalizeSelectionToolbarLists } from "@/utils/selection-toolbar-order"
import { floatingButtonSchema } from "./floating-button"
import { glossaryConfigSchema } from "./glossary"
import { providersConfigSchema } from "./provider"
import { selectionToolbarCustomActionsSchema } from "./selection-toolbar"
import { selectionToolbarBuiltInActionsSchema } from "./selection-toolbar"
import { shortcutSchema } from "./shortcut"
import { siteRulesConfigSchema } from "./site-rules"
import { videoSubtitlesSchema } from "./subtitles"
import { translateConfigSchema } from "./translate"

// Language schema
const languageSchema = z.object({
  sourceCode: langCodeISO6393Schema.or(z.literal("auto")),
  targetCode: langCodeISO6393Schema,
  level: langLevel,
})

const selectionToolbarFeatureSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().nonempty(),
  shortcut: shortcutSchema,
})

// Text selection toolbar schema
const selectionToolbarSchema = z
  .object({
    enabled: z.boolean(),
    disabledSelectionToolbarPatterns: z.array(z.string()),
    opacity: z.number().min(MIN_SELECTION_OVERLAY_OPACITY).max(MAX_SELECTION_OVERLAY_OPACITY),
    features: z.object({
      translate: selectionToolbarFeatureSchema,
    }),
    builtInActions: selectionToolbarBuiltInActionsSchema,
    customActions: selectionToolbarCustomActionsSchema.default([]),
    order: z.array(z.string()).optional(),
    unpinned: z.array(z.string()).optional(),
  })
  .transform(normalizeSelectionToolbarLists)

// side content schema

// Translation Hub schema. `.default()` mirrors `uiLanguageSchema`: it lets a
// config stored before this field existed still parse in UI contexts that load
// ahead of the background migration, instead of falling back to DEFAULT_CONFIG
// and writing that over the user's settings.

// beta experience schema

// context menu schema
const contextMenuSchema = z.object({
  enabled: z.boolean(),
})

// input translation language selector: 'sourceCode', 'targetCode', or fixed language code

// input translation schema (triple-space trigger)

// Export types for use in components

const inputTranslationLangSchema = z.union([
  z.literal("sourceCode"),
  z.literal("targetCode"),
  langCodeISO6393Schema,
])
const inputTranslationSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().nonempty(),
  fromLang: inputTranslationLangSchema,
  toLang: inputTranslationLangSchema,
  enableCycle: z.boolean(),
  timeThreshold: z.number().min(100).max(1000),
})
export type InputTranslationLang = z.infer<typeof inputTranslationLangSchema>
// site control schema
const siteControlSchema = z.object({
  mode: z.enum(["blacklist", "whitelist"]),
  blacklistPatterns: z.array(z.string()),
  whitelistPatterns: z.array(z.string()),
})

// Interface language for the extension UI, independent of the browser language.
// "auto" follows the browser UI language; explicit values are the supported locales.
// MUST stay in sync with SUPPORTED_UI_LOCALES in `@/utils/i18n/resources` and `src/locales/`.
// `.default("auto")` is load-bearing: it lets configs stored before this field existed still
// parse successfully, avoiding the destructive fallback-to-DEFAULT_CONFIG path in
// `writeConfigAtom` / `initializeConfig` during the upgrade window.
const uiLanguageSchema = z
  .enum(["auto", "az", "en", "es", "ja", "ko", "ru", "tr", "vi", "zh-CN", "zh-TW"])
  .default("auto")
export type UiLanguage = z.infer<typeof uiLanguageSchema>

// Complete config schema
export const configSchema = z
  .object({
    language: languageSchema,
    providersConfig: providersConfigSchema,
    pageTranslation: translateConfigSchema,

    selectionToolbar: selectionToolbarSchema,

    contextMenu: contextMenuSchema,
    inputTranslation: inputTranslationSchema.optional(),
    floatingButton: floatingButtonSchema.default(DEFAULT_FLOATING_BUTTON_CONFIG),
    glossary: glossaryConfigSchema,
    videoSubtitles: videoSubtitlesSchema.optional(),

    siteControl: siteControlSchema,
    siteRules: siteRulesConfigSchema,
    uiLanguage: uiLanguageSchema,
  })
  .transform((data) => ({
    ...data,
    inputTranslation: data.inputTranslation ?? {
      ...DEFAULT_INPUT_TRANSLATION_CONFIG,
      providerId: data.pageTranslation.providerId,
    },
    videoSubtitles: data.videoSubtitles ?? {
      ...DEFAULT_VIDEO_SUBTITLES_CONFIG,
      providerId: data.pageTranslation.providerId,
    },
  }))
  .superRefine((data, ctx) => {
    for (const featureKey of FEATURE_KEYS) {
      const def = FEATURE_PROVIDER_DEFS[featureKey]
      const providerId = def.getProviderId(data)

      if (
        !doesProviderSupportsCapability(featureKey, data.providersConfig, providerId, {
          requireEnable: true,
        })
      ) {
        ctx.addIssue({
          code: "invalid_value",
          values: getProviderIdsForCapability(featureKey, data.providersConfig, {
            requireEnable: true,
          }),
          message: `Invalid provider id "${providerId}".`,
          path: [...def.configPath],
        })
        continue
      }
    }

    // Validate languageDetection: when mode is "llm", providerId must be a valid enabled LLM provider

    const actionProviderEntries = [
      ...data.selectionToolbar.customActions.map((action, index) => ({
        providerId: action.providerId,
        path: ["selectionToolbar", "customActions", index, "providerId"] as const,
      })),
      ...BUILT_IN_ACTION_IDS.map((id) => {
        const key = BUILT_IN_ACTION_KEYS[id]
        return {
          providerId: data.selectionToolbar.builtInActions[key].providerId,
          path: ["selectionToolbar", "builtInActions", key, "providerId"] as const,
        }
      }),
    ]

    actionProviderEntries.forEach(({ providerId, path }) => {
      if (
        !doesProviderSupportsCapability("customAction", data.providersConfig, providerId, {
          requireEnable: true,
        })
      ) {
        ctx.addIssue({
          code: "invalid_value",
          values: getProviderIdsForCapability("customAction", data.providersConfig, {
            requireEnable: true,
          }),
          message: `Invalid provider id "${providerId}".`,
          path: [...path],
        })
      }
    })
  })

export type Config = z.infer<typeof configSchema>
