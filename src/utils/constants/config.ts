import type { Config } from "@/types/config/config"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import type { PageTranslateRange } from "@/types/config/translate"
import {
  BUILT_IN_ACTION_DEFAULT_SHORTCUTS,
  BUILT_IN_DICTIONARY_ACTION_ID,
  BUILT_IN_SENTENCE_ANALYSIS_ACTION_ID,
} from "./custom-action"
import {
  createDictionaryDefinition,
  createSentenceAnalysisDefinition,
} from "./custom-action-templates"
import { DEFAULT_NODE_TRANSLATION_SHORTCUT_KEY } from "./hotkeys"
import { DEFAULT_TRANSLATE_PROMPTS_CONFIG } from "./prompt"
import {
  buildDefaultProviderConfigList,
  DEFAULT_PROVIDER_CONFIG,
  DEFAULT_PROVIDER_CONFIG_LIST,
  DEFAULT_TRANSLATE_PROVIDER_ID,
} from "./providers"
import { DEFAULT_SELECTION_OVERLAY_OPACITY } from "./selection"
import {
  DEFAULT_AUTO_TRANSLATE_SHORTCUT_KEY,
  DEFAULT_BATCH_CONFIG,
  DEFAULT_MIN_CHARACTERS_PER_NODE,
  DEFAULT_MIN_WORDS_PER_NODE,
  DEFAULT_PRELOAD_MARGIN,
  DEFAULT_PRELOAD_THRESHOLD,
  DEFAULT_REQUEST_CAPACITY,
  DEFAULT_REQUEST_RATE,
  DEFAULT_SELECTION_TRANSLATION_SHORTCUT_KEY,
  DEFAULT_TRANSLATION_MODE_SHORTCUT_KEY,
} from "./translate"
import { TRANSLATION_NODE_STYLE_ON_INSTALLED } from "./translation-node-style"

export { CONFIG_STORAGE_KEY } from "./config-storage-key"

export const THEME_STORAGE_KEY = "theme"
export const DEFAULT_DETECTED_CODE = "eng" as const
export const CONFIG_SCHEMA_VERSION = 1

// A built-in action's card, rebuilt only when its fields' ids change: it is
// resolved on every read of the action. Cards place fields by id and hold no
// words of their own (the sentence analysis card's come from ctx), so nothing
// else about the language or the names goes into one.

export function createDefaultDictionaryAction(): SelectionToolbarCustomAction {
  const action = createDictionaryDefinition(DEFAULT_PROVIDER_CONFIG.openai.id)
  const outputSchema = action.outputSchema.map((field) => ({
    ...field,
    id: field.id.startsWith("dictionary-")
      ? `default-${field.id}`
      : `default-dictionary-${field.id}`,
  }))
  return {
    ...action,
    id: BUILT_IN_DICTIONARY_ACTION_ID,
    outputSchema,
    // Built for the renamed ids: the card's tail matches the fields it has
    // already placed by id, so the preset's card (keyed on `dictionary-*`)
    // would list every slot field a second time.
  }
}

export function createDefaultSentenceAnalysisAction(): SelectionToolbarCustomAction {
  const action = createSentenceAnalysisDefinition(DEFAULT_PROVIDER_CONFIG.openai.id)
  const outputSchema = action.outputSchema.map((field) => ({
    ...field,
    id: `default-${field.id}`,
  }))
  return {
    ...action,
    id: BUILT_IN_SENTENCE_ANALYSIS_ACTION_ID,
    outputSchema,
  }
}

export const DEFAULT_CONFIG: Config = {
  language: {
    sourceCode: "auto",
    targetCode: "cmn",
    level: "intermediate",
  },
  providersConfig: DEFAULT_PROVIDER_CONFIG_LIST,
  pageTranslation: {
    providerId: DEFAULT_TRANSLATE_PROVIDER_ID,
    mode: "bilingual",
    modeShortcut: DEFAULT_TRANSLATION_MODE_SHORTCUT_KEY,
    node: {
      enabled: false,
      hotkey: "control",
      shortcut: DEFAULT_NODE_TRANSLATION_SHORTCUT_KEY,
      forceRetranslation: false,
    },
    page: {
      range: "all",
      translateTitle: true,
      autoTranslatePatterns: [],
      neverAutoTranslatePatterns: [],
      autoTranslateLanguages: [],
      shortcut: DEFAULT_AUTO_TRANSLATE_SHORTCUT_KEY,
      preload: {
        margin: DEFAULT_PRELOAD_MARGIN,
        threshold: DEFAULT_PRELOAD_THRESHOLD,
      },
      minCharactersPerNode: DEFAULT_MIN_CHARACTERS_PER_NODE,
      minWordsPerNode: DEFAULT_MIN_WORDS_PER_NODE,
      enableTargetLanguageSkip: true,
      skipLanguages: [],
    },
    enableAIContentAware: false,
    customPromptsConfig: DEFAULT_TRANSLATE_PROMPTS_CONFIG,
    requestQueueConfig: {
      capacity: DEFAULT_REQUEST_CAPACITY,
      rate: DEFAULT_REQUEST_RATE,
    },
    batchQueueConfig: {
      maxCharactersPerBatch: DEFAULT_BATCH_CONFIG.maxCharactersPerBatch,
      maxItemsPerBatch: DEFAULT_BATCH_CONFIG.maxItemsPerBatch,
    },
    translationNodeStyle: {
      preset: TRANSLATION_NODE_STYLE_ON_INSTALLED,
      isCustom: false,
      customCSS: null,
    },
  },

  selectionToolbar: {
    enabled: true,
    disabledSelectionToolbarPatterns: [],
    opacity: DEFAULT_SELECTION_OVERLAY_OPACITY,
    features: {
      translate: {
        enabled: true,
        providerId: DEFAULT_TRANSLATE_PROVIDER_ID,
        shortcut: DEFAULT_SELECTION_TRANSLATION_SHORTCUT_KEY,
      },
    },
    builtInActions: {
      dictionary: {
        enabled: true,
        providerId: DEFAULT_PROVIDER_CONFIG.openai.id,
        shortcut: BUILT_IN_ACTION_DEFAULT_SHORTCUTS[BUILT_IN_DICTIONARY_ACTION_ID],
      },
      sentenceAnalysis: {
        enabled: true,
        providerId: DEFAULT_PROVIDER_CONFIG.openai.id,
        shortcut: BUILT_IN_ACTION_DEFAULT_SHORTCUTS[BUILT_IN_SENTENCE_ANALYSIS_ACTION_ID],
      },
    },
  },

  contextMenu: {
    enabled: true,
  },

  siteControl: {
    mode: "blacklist",
    blacklistPatterns: [],
    whitelistPatterns: [],
  },
  siteRules: {
    userRules: [],
    disabledBuiltInRules: [],
  },
  uiLanguage: "auto",
}

export function buildFreshDefaultConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    providersConfig: buildDefaultProviderConfigList(),
    selectionToolbar: {
      ...DEFAULT_CONFIG.selectionToolbar,
      builtInActions: {
        dictionary: {
          enabled: true,
          providerId: DEFAULT_PROVIDER_CONFIG.openai.id,
        },
        sentenceAnalysis: {
          enabled: true,
          providerId: DEFAULT_PROVIDER_CONFIG.openai.id,
        },
      },
    },
  }
}

export const PAGE_TRANSLATE_RANGE_ITEMS: Record<PageTranslateRange, { label: string }> = {
  main: { label: "Main" },
  all: { label: "All" },
}
