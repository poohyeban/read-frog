import type { createSubtitleTrackIdentity } from "./track-identity"
import { sendMessage } from "@/utils/message"

/** Skip historical hashing only when the indexed version range proves no pre-v3 records exist. */
export function createSubtitleCandidateReader(
  identity: ReturnType<typeof createSubtitleTrackIdentity>,
) {
  let legacyTrackKeys: string[] | undefined
  return async (start: number, end: number, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const { trackKey } = identity
    if (!legacyTrackKeys) {
      const probe = await sendMessage("getSubtitleCandidateWindow", { trackKey, start, end })
      signal?.throwIfAborted()
      if (!probe.mayHaveLegacy) return probe.bundles
      legacyTrackKeys = identity.getLegacyTrackKeys()
      if (!legacyTrackKeys.length) return probe.bundles
    }
    // Never infer historical completeness from a partial hit under the current key.
    return sendMessage("getSubtitleCandidates", { trackKey, legacyTrackKeys, start, end })
  }
}
