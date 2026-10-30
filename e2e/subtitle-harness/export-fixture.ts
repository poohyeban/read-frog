import { buildSubtitlesSrtContent } from "@benchmark/source-srt"
export const exports: Array<{ count: number; unique: number; valid: boolean; bytes: number }> = []
export async function downloadSubtitlesAsSrt({ subtitles }: any) {
  const srt = buildSubtitlesSrtContent(subtitles)
  exports.push({
    count: subtitles.length,
    unique: new Set(subtitles.map((cue: any) => cue.start)).size,
    valid: !/NaN|Infinity/.test(srt),
    bytes: srt.length,
  })
}
