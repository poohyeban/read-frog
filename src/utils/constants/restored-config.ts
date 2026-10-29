import { DEFAULT_TRANSLATE_PROVIDER_ID } from "./providers"
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
