import type { SubtitlesFragment } from "./types"

interface Publication {
  previous: WeakRef<readonly SubtitlesFragment[]>
  updates: readonly SubtitlesFragment[]
}
const publications = new WeakMap<readonly SubtitlesFragment[], Publication>()
/** The predecessor is weak: keeping today's track must not retain every old snapshot. */
export function recordTrackPublication(
  current: readonly SubtitlesFragment[],
  previous: readonly SubtitlesFragment[],
  updates: readonly SubtitlesFragment[],
) {
  publications.set(current, { previous: new WeakRef(previous), updates })
}
export function trackUpdates(
  current: readonly SubtitlesFragment[],
  previous: readonly SubtitlesFragment[],
) {
  const publication = publications.get(current)
  return publication?.previous.deref() === previous ? publication.updates : undefined
}
