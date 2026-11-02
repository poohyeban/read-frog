import type { Config } from "@/types/config/config"
import { Sha256Hex } from "@/utils/hash"
const revisions = new WeakMap<Config, number>()
export function copyConfigSnapshot(config: Config, revision: number): Config {
  const copy = structuredClone(config)
  revisions.set(copy, revision)
  return copy
}
/** Metadata on the returned copy; never reads storage or a later global version. */
export function getConfigSnapshotRevision(config: Config): number {
  return revisions.get(config) ?? 0
}

// A read projection of the existing config owner's notifications, not another
// config version or store. Only translation semantics invalidate pending commits.
let currentTranslationIdentity: string | null | undefined
let currentInputIdentity: string | null | undefined
const identities = new WeakMap<Config, string>()
function translationIdentity(config: Config): string {
  const cached = identities.get(config)
  if (cached) return cached
  const page = config.pageTranslation
  return Sha256Hex(
    JSON.stringify([
      page.providerId,
      config.providersConfig.find((provider) => provider.id === page.providerId),
      config.language,
      page.mode,
      page.enableAIContentAware,
      page.customPromptsConfig,
      page.translationNodeStyle,
      page.page.skipLanguages,
      config.glossary.enabled,
      config.siteRules,
    ]),
  )
}
/** Called only by config/storage when it receives or validates a new snapshot. */
export function noteCurrentConfigSnapshot(config: Config | null | undefined): void {
  try {
    currentInputIdentity =
      config?.inputTranslation && config.language ? inputIdentity(config) : null
    currentTranslationIdentity =
      config?.pageTranslation && config.language ? translationIdentity(config) : null
  } catch {
    // Storage notifications precede schema validation. Invalid/imported data
    // must invalidate pending commits without breaking the config owner's reset.
    currentTranslationIdentity = null
    currentInputIdentity = null
  }
}
export function captureTranslationConfigValidity(config?: Config): () => boolean {
  const identity = config ? translationIdentity(config) : currentTranslationIdentity
  if (config && identity) identities.set(config, identity)
  return () => currentTranslationIdentity === undefined || identity === currentTranslationIdentity
}

function inputIdentity(config: Config): string {
  return Sha256Hex(
    JSON.stringify([
      config.inputTranslation,
      config.providersConfig.find((provider) => provider.id === config.inputTranslation.providerId),
      config.language,
      config.glossary.enabled,
      config.pageTranslation.customPromptsConfig,
      config.pageTranslation.enableAIContentAware,
    ]),
  )
}
export function captureInputConfigValidity(config: Config): () => boolean {
  const identity = inputIdentity(config)
  return () => currentInputIdentity === undefined || currentInputIdentity === identity
}
