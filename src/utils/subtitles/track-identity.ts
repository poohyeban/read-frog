import type { SubtitlesVideoContext } from "./processor/translator"
import type { SubtitlesFragment } from "./types"
import type { Config } from "@/types/config/config"
import { Sha256Fields, safeLegacyFieldsHash } from "@/utils/hash"
import { subtitleCacheIdentity, legacySubtitleConfigIdentity } from "./config-identity"

/** The exact historical identities remain bound to this session's source and configuration. */
export function createSubtitleTrackIdentity(
  videoId: string,
  source: SubtitlesFragment[],
  config: Config | null,
  context: SubtitlesVideoContext,
) {
  const serializedTrack = JSON.stringify(source),
    serializedContext = JSON.stringify(context)
  const fields = [videoId, serializedTrack, subtitleCacheIdentity(config), serializedContext]
  const previousTrackKey = Sha256Fields(...fields)
  const trackKey = `subtitle-track-v3:${previousTrackKey}`
  const legacyConfig = config
    ? {
        ...config,
        providersConfig: config.providersConfig.map((provider) =>
          provider.id === config.videoSubtitles.providerId
            ? { ...provider, enabled: true }
            : provider,
        ),
      }
    : null
  const legacyConfigKey = legacySubtitleConfigIdentity(legacyConfig)
  let legacyTrackKeys: string[] | undefined
  return {
    trackKey,
    getLegacyTrackKeys: () =>
      (legacyTrackKeys ??= [
        previousTrackKey,
        safeLegacyFieldsHash(...fields),
        safeLegacyFieldsHash(videoId, serializedTrack, legacyConfigKey, serializedContext),
      ].filter((key): key is string => key !== undefined)),
  }
}
