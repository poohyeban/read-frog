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
    currentTranslationIdentity =
      config?.pageTranslation && config.language ? translationIdentity(config) : null
  } catch {
    // Storage notifications precede schema validation. Invalid/imported data
    // must invalidate pending commits without breaking the config owner's reset.
    currentTranslationIdentity = null
  }
}
export function captureTranslationConfigValidity(config?: Config): () => boolean {
  const identity = config ? translationIdentity(config) : currentTranslationIdentity
  if (config && identity) identities.set(config, identity)
  return () => currentTranslationIdentity === undefined || identity === currentTranslationIdentity
}
