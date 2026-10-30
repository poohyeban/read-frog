// Historical implementation port: the actual old TranscriptRow/buildTranscript remain under test.
import React, { useLayoutEffect, useRef } from "react"
import { TranscriptRow } from "@/entrypoints/subtitles.content/ui/subtitles-sidebar/sections/transcript/row"
export function TranscriptList({ lines, activeIndex, following, onSeek }: any) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (following && activeIndex >= 0)
      ref.current
        ?.querySelector<HTMLElement>('[aria-current="true"]')
        ?.scrollIntoView({ block: "center", behavior: "instant" })
  }, [following, activeIndex])
  return (
    <div ref={ref}>
      {lines.map((line: any, index: number) => (
        <TranscriptRow
          key={line.start}
          line={line}
          isActive={index === activeIndex}
          onSeek={onSeek}
        />
      ))}
    </div>
  )
}
