import React from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { TranscriptList } from "@/entrypoints/subtitles.content/ui/subtitles-sidebar/sections/transcript/list"
import { buildTranscript } from "@/utils/subtitles/transcript"
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
document.getElementById("root")!.dataset.slot = "scroll-area-viewport"
const root = createRoot(document.getElementById("root")!)
const seek = () => {}
const style = document.createElement("style")
style.textContent =
  "#root{width:420px;height:600px;overflow:auto;font:14px/1.625 sans-serif}button{display:block;width:100%;padding:10px 12px;text-align:left;border:0;margin-bottom:4px}span{display:block;line-height:23px}"
document.head.append(style)
function List({
  lines,
  activeIndex = -1,
  following = false,
}: {
  lines: ReturnType<typeof buildTranscript>
  activeIndex?: number
  following?: boolean
}) {
  return (
    <TranscriptList lines={lines} activeIndex={activeIndex} following={following} onSeek={seek} />
  )
}
;(window as any).runSubtitleBenchmark = async () => {
  const scales = []
  for (const size of [100, 1000, 10000, 50000]) {
    const rowCounts: number[] = []
    const mount = [],
      update500 = [],
      seekScroll = [],
      heaps = []
    const source = Array.from({ length: size }, (_, i) => ({
      start: i * 2000,
      end: i * 2000 + 1800,
      text: `Sentence ${i} with enough words to wrap a long original subtitle across lines.`,
    }))
    const translated = source.map((cue) => ({
      ...cue,
      translation: `译文 ${cue.start}，包含正常的多行字幕。`,
    }))
    for (let sample = 0; sample < 30; sample++) {
      let stamp = performance.now()
      flushSync(() => root.render(<List lines={buildTranscript(source, translated)} />))
      document.getElementById("root")!.scrollTop = 0
      await nextFrame()
      await nextFrame()
      mount.push(performance.now() - stamp)
      const changed = translated.map((cue, i) =>
        i < 500 ? { ...cue, translation: `Updated ${sample} ${i}` } : cue,
      )
      stamp = performance.now()
      flushSync(() => root.render(<List lines={buildTranscript(source, changed)} />))
      await nextFrame()
      await nextFrame()
      update500.push(performance.now() - stamp)
      stamp = performance.now()
      flushSync(() =>
        root.render(
          <List lines={buildTranscript(source, changed)} activeIndex={size - 1} following />,
        ),
      )
      await nextFrame()
      await nextFrame()
      seekScroll.push(performance.now() - stamp)
      rowCounts.push(document.querySelectorAll("button").length)
      heaps.push((performance as any).memory.usedJSHeapSize)
      flushSync(() => root.render(null))
      await nextFrame()
    }
    scales.push({ size, mount, update500, seekScroll, heaps, rowCounts })
  }
  return {
    scales,
    note: "Actual production React TranscriptRow and buildTranscript in Chromium, controlled fixed-width CSS; 30 mounts per size. Heap is sampled, not process peak.",
  }
}
