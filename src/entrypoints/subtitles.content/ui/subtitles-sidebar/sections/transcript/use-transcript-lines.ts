import type { UseQueryResult } from "@tanstack/react-query"
import type { TranscriptLine } from "@/utils/subtitles/transcript"
import { useQuery } from "@tanstack/react-query"
import { atom, useAtomValue } from "jotai"
import { selectAtom } from "jotai/utils"
import { useMemo } from "react"
import { CueTimeIndex } from "@/utils/subtitles/time-index"
import { buildTranscript } from "@/utils/subtitles/transcript"
import {
  currentTimeMsAtom,
  currentVideoIdAtom,
  sourceTrackAtom,
  translatedTrackAtom,
} from "../../../../atoms"
import { useSubtitlesUI } from "../../../subtitles-ui-context"

interface TranscriptLines {
  lines: TranscriptLine[]
  activeIndex: number
  videoId: string | null
  query: UseQueryResult<boolean>
}

const tracksAtom = atom((get) => [get(sourceTrackAtom), get(translatedTrackAtom)] as const)
const linesAtom = selectAtom(
  tracksAtom,
  ([source, translated], previous: TranscriptLine[] | undefined): TranscriptLine[] =>
    buildTranscript(source, translated, previous),
)

export function useTranscriptLines(): TranscriptLines {
  const { ensureSourceTrackPublished } = useSubtitlesUI()
  const lines = useAtomValue(linesAtom)
  const videoId = useAtomValue(currentVideoIdAtom)

  const activeIndexAtom = useMemo(() => {
    const index = new CueTimeIndex(lines)
    return atom((get) => index.findActive(get(currentTimeMsAtom)))
  }, [lines])
  const activeIndex = useAtomValue(activeIndexAtom)

  const query = useQuery({
    queryKey: ["subtitles", "source-track", videoId],
    queryFn: async () => {
      await ensureSourceTrackPublished()
      return true
    },
    enabled: lines.length === 0,
    retry: false,
    meta: { suppressToast: true },
  })

  return { lines, activeIndex, videoId, query }
}
