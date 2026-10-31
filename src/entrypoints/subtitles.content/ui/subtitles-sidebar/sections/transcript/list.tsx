import type { Ref } from "react"
import type { TranscriptLine } from "@/utils/subtitles/transcript"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { cueIdentity, getCueTimeline } from "@/utils/subtitles/cue-timeline"
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
          key={line.anchorKey ?? cueIdentity(line)}
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
  const anchoredLines = useRef(lines)
  const scrollAnchor = useRef<{ time: number; offset: number } | null>(null)
  const getScrollElement = useCallback(
    () => rootRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null,
    [],
  )
  const getItemKey = useCallback(
    (index: number) => lines[index]!.anchorKey ?? cueIdentity(lines[index]!),
    [lines],
  )
  // The component explicitly opts out of React Compiler; the mutable virtualizer stays local.
  // oxlint-disable-next-line react/incompatible-library
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
    const viewport = getScrollElement()
    if (!viewport) return undefined
    const anchor = scrollAnchor.current
    const changed = anchoredLines.current !== lines
    anchoredLines.current = lines
    let frame = 0,
      attempts = 0,
      restoring = changed && !following && !!anchor
    const remember = () => {
      if (restoring) return
      const item = virtualizer.getVirtualItems().find((row) => row.end > viewport.scrollTop)
      const line = item && lines[item.index]
      if (item && line)
        scrollAnchor.current = { time: line.start, offset: item.start - viewport.scrollTop }
    }
    const cancel = () => {
      restoring = false
      cancelAnimationFrame(frame)
    }
    if (restoring && anchor) {
      const index = getCueTimeline(lines).indexAt(anchor.time)
      const restore = () => {
        const position = index < 0 ? undefined : virtualizer.getOffsetForIndex(index, "start")?.[0]
        if (position !== undefined) virtualizer.scrollToOffset(position - anchor.offset)
        if (++attempts < 6) frame = requestAnimationFrame(restore)
        else {
          restoring = false
          remember()
        }
      }
      restore()
    }
    viewport.addEventListener("scroll", remember, { passive: true })
    viewport.addEventListener("wheel", cancel, { passive: true })
    viewport.addEventListener("pointerdown", cancel, { passive: true })
    viewport.addEventListener("touchmove", cancel, { passive: true })
    viewport.addEventListener("keydown", cancel)
    return () => {
      cancel()
      viewport.removeEventListener("scroll", remember)
      viewport.removeEventListener("wheel", cancel)
      viewport.removeEventListener("pointerdown", cancel)
      viewport.removeEventListener("touchmove", cancel)
      viewport.removeEventListener("keydown", cancel)
    }
  }, [lines, following, getScrollElement, virtualizer])
  useLayoutEffect(() => {
    if (!following || activeIndex < 0) return undefined
    // TanStack's scrollToIndex retries cannot be cancelled. Own the finite
    // measurement corrections so manual scrolling and new rows revoke them.
    let frame = 0,
      attempts = 0
    const center = () => {
      const offset = virtualizer.getOffsetForIndex(activeIndex, "center")?.[0]
      if (offset !== undefined) virtualizer.scrollToOffset(offset)
      if (++attempts < 6) frame = requestAnimationFrame(center)
    }
    center()
    return () => cancelAnimationFrame(frame)
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
