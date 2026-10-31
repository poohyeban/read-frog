import { DEFAULT_SUBTITLE_BUDGET } from "@/utils/subtitles/work-policy"
import { BUILT_IN_DICTIONARY_ACTION_ID } from "./custom-action"
import { DEFAULT_SUBTITLE_TRANSLATE_PROMPTS_CONFIG } from "./prompt"
import { DEFAULT_TRANSLATE_PROVIDER_ID } from "./providers"
import {
  DEFAULT_BACKGROUND_OPACITY,
  DEFAULT_DISPLAY_MODE,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SCALE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_SUBTITLE_COLOR,
  DEFAULT_SUBTITLE_POSITION,
  DEFAULT_SUBTITLES_TOGGLE_SHORTCUT_KEY,
  DEFAULT_TRANSLATION_POSITION,
} from "./subtitles"
import { DEFAULT_BATCH_CONFIG, DEFAULT_REQUEST_CAPACITY, DEFAULT_REQUEST_RATE } from "./translate"
// Upstream v1.54.1 defaults, with the Lite user's translation provider.
export const DEFAULT_INPUT_TRANSLATION_CONFIG = {
  enabled: true,
  providerId: DEFAULT_TRANSLATE_PROVIDER_ID,
  fromLang: "targetCode",
  toLang: "sourceCode",
  enableCycle: false,
  timeThreshold: 300,
} as const
export const DEFAULT_FLOATING_BUTTON_CONFIG = {
  enabled: true,
  position: 0.66,
  side: "right",
  disabledFloatingButtonPatterns: [] as string[],
  clickAction: "translate",
  locked: false,
} as const

export const DEFAULT_VIDEO_SUBTITLES_CONFIG = {
  workBudget: { ...DEFAULT_SUBTITLE_BUDGET },
  enabled: true,
  autoStart: { youtube: false, xcom: false, netflix: false },
  toggleShortcut: DEFAULT_SUBTITLES_TOGGLE_SHORTCUT_KEY,
  providerId: DEFAULT_TRANSLATE_PROVIDER_ID,
  style: {
    displayMode: DEFAULT_DISPLAY_MODE,
    translationPosition: DEFAULT_TRANSLATION_POSITION,
    main: {
      fontFamily: DEFAULT_FONT_FAMILY,
      fontScale: DEFAULT_FONT_SCALE,
      color: DEFAULT_SUBTITLE_COLOR,
      fontWeight: DEFAULT_FONT_WEIGHT,
    },
    translation: {
      fontFamily: DEFAULT_FONT_FAMILY,
      fontScale: DEFAULT_FONT_SCALE,
      color: DEFAULT_SUBTITLE_COLOR,
      fontWeight: DEFAULT_FONT_WEIGHT,
    },
    container: {
      backgroundOpacity: DEFAULT_BACKGROUND_OPACITY,
    },
    customCSS: null,
  },
  aiSegmentation: false,
  wordLookupActionId: BUILT_IN_DICTIONARY_ACTION_ID,
  requestQueueConfig: {
    capacity: DEFAULT_REQUEST_CAPACITY,
    rate: DEFAULT_REQUEST_RATE,
  },
  batchQueueConfig: {
    maxCharactersPerBatch: DEFAULT_BATCH_CONFIG.maxCharactersPerBatch,
    maxItemsPerBatch: DEFAULT_BATCH_CONFIG.maxItemsPerBatch,
  },
  customPromptsConfig: DEFAULT_SUBTITLE_TRANSLATE_PROMPTS_CONFIG,
  position: DEFAULT_SUBTITLE_POSITION,
} as const
