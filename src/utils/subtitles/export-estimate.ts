import type { SubtitlesFragment } from "./types"
import { chunkSubtitleWork, estimateInputTokens, subtitleOutputLimit } from "./work-policy"

export function estimateSubtitleExport(
  source: readonly SubtitlesFragment[],
  ai: boolean,
  batchSize = 4,
  context = false,
) {
  const chunks = chunkSubtitleWork(source)
  const batches = chunkSubtitleWork(source, Math.max(1, batchSize))
  const requests = batches.length + (ai ? chunks.length : 0) + (context ? chunks.length : 0)
  const inputCharacters = source.reduce((n, c) => n + c.text.length, 0)
  const estimatedTokens =
    (context ? chunks.length * 6000 : 0) +
    batches.reduce((n, c) => {
      const text = c.map((cue) => cue.text).join("\n")
      return n + estimateInputTokens(text) + 2000 + subtitleOutputLimit(text)
    }, 0) +
    (ai
      ? chunks.reduce(
          (n, c) =>
            n +
            estimateInputTokens(JSON.stringify(c)) +
            subtitleOutputLimit(JSON.stringify(c), true) +
            2000,
          0,
        )
      : 0)
  const durationMs = source.length
    ? source.reduce((n, c) => Math.max(n, c.end), 0) -
      source.reduce((n, c) => Math.min(n, c.start), Infinity)
    : 0
  return {
    requests,
    inputCharacters,
    estimatedTokens,
    durationMs,
    needsConfirmation: durationMs > 10 * 60_000 || requests > 20,
  }
}
