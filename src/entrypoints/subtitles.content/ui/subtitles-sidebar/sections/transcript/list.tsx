import type { Ref } from "react"
import type { TranscriptLine } from "@/utils/subtitles/transcript"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { cueIdentity } from "@/utils/subtitles/cue-timeline"
import { TranscriptRow } from "./row"

export const TRANSCRIPT_VIRTUALIZATION_THRESHOLD = 200
interface TranscriptListProps {
  lines: TranscriptLine[]
  activeIndex: number
  following: boolean
  onSeek: (seconds: number) => void
  activeRowRef?: Ref<HTMLButtonElement>
  onActiveAboveChange?: (above: boolean) => void
}

export function TranscriptList(props: TranscriptListProps) {
  if (props.lines.length > TRANSCRIPT_VIRTUALIZATION_THRESHOLD)
    return <VirtualTranscriptList {...props} />
  return (
    <div className="space-y-1 p-2">
      {props.lines.map((line, index) => (
        <TranscriptRow
          key={cueIdentity(line)}
          line={line}
          isActive={index === props.activeIndex}
          activeRowRef={index === props.activeIndex ? props.activeRowRef : undefined}
          onSeek={props.onSeek}
        />
      ))}
    </div>
  )
}

function VirtualTranscriptList({
  lines,
  activeIndex,
  following,
  onSeek,
  onActiveAboveChange,
}: TranscriptListProps) {
  "use no memo"
  const rootRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const getScrollElement = useCallback(
    () => rootRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null,
    [],
  )
  const getItemKey = useCallback((index: number) => cueIdentity(lines[index]!), [lines])
  // The component explicitly opts out of React Compiler; the mutable virtualizer stays local.
  // oxlint-disable-next-line react(incompatible-library)
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: lines.length,
    getScrollElement,
    estimateSize: () => 96,
    getItemKey,
    overscan: 8,
    scrollMargin,
  })
  useLayoutEffect(() => {
    const root = rootRef.current,
      viewport = getScrollElement()
    if (root && viewport)
      setScrollMargin(
        root.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop,
      )
  }, [getScrollElement])
  useLayoutEffect(() => {
    if (following && activeIndex >= 0)
      virtualizer.scrollToIndex(activeIndex, { align: "center", behavior: "auto" })
  }, [following, activeIndex, virtualizer])
  const scrollOffset = virtualizer.scrollOffset
  useEffect(() => {
    const offset =
      activeIndex >= 0 ? virtualizer.getOffsetForIndex(activeIndex, "start")?.[0] : undefined
    onActiveAboveChange?.(offset !== undefined && offset < (scrollOffset ?? 0))
  }, [activeIndex, scrollOffset, virtualizer, onActiveAboveChange])

  return (
    <div
      ref={rootRef}
      role="list"
      style={{ position: "relative", height: virtualizer.getTotalSize(), width: "100%" }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          ref={virtualizer.measureElement}
          role="listitem"
          aria-posinset={item.index + 1}
          aria-setsize={lines.length}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            padding: "0 8px 4px",
            transform: `translateY(${item.start - scrollMargin}px)`,
          }}
        >
          <TranscriptRow
            line={lines[item.index]!}
            isActive={item.index === activeIndex}
            onSeek={onSeek}
          />
        </div>
      ))}
    </div>
  )
}
