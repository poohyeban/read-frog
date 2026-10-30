import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Provider } from "jotai"
import React from "react"
import { createRoot } from "react-dom/client"
import {
  subtitlesStore,
  sourceTrackAtom,
  translatedTrackAtom,
  currentTimeMsAtom,
  currentVideoIdAtom,
} from "@/entrypoints/subtitles.content/atoms"
import { TranscriptSection } from "@/entrypoints/subtitles.content/ui/subtitles-sidebar/sections/transcript"
import { SubtitlesUIContext } from "@/entrypoints/subtitles.content/ui/subtitles-ui-context"
const delay = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
const source = Array.from({ length: 50_000 }, (_, i) => ({
  start: i * 2000,
  end: i * 2000 + 1800,
  text: `Sentence ${i}. ${"Variable length multilingual 字幕内容。".repeat((i % 4) + 1)}`,
}))
const seeks: number[] = []
const style = document.createElement("style")
style.textContent =
  '[data-slot="scroll-area-viewport"]{width:420px;height:600px;overflow:auto;font:14px/1.625 sans-serif}button{display:block;width:100%;padding:10px 12px;text-align:left;border:0}span{display:block;line-height:23px}.relative{position:relative}.sticky{position:sticky}.h-0{height:0}.top-3{top:12px}.bottom-3{bottom:12px}'
document.head.append(style)
subtitlesStore.set(sourceTrackAtom, source)
subtitlesStore.set(currentVideoIdAtom, "functional-video")
subtitlesStore.set(currentTimeMsAtom, 2_120_000)
createRoot(document.getElementById("root")!).render(
  <Provider store={subtitlesStore}>
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesUIContext
        value={
          {
            ensureSourceTrackPublished: async () => {},
            seekTo: (seconds: number) => {
              seeks.push(seconds)
              subtitlesStore.set(currentTimeMsAtom, seconds * 1000)
            },
          } as never
        }
      >
        <div data-slot="scroll-area">
          <div data-slot="scroll-area-viewport" tabIndex={0}>
            <TranscriptSection />
          </div>
          <div data-slot="scroll-area-scrollbar" />
        </div>
      </SubtitlesUIContext>
    </QueryClientProvider>
  </Provider>,
)
;(window as any).runSubtitleBenchmark = async () => {
  const checks: Record<string, boolean> = {}
  await delay(300)
  const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
  const visible = () => {
    const rect = document.querySelector('[aria-current="true"]')?.getBoundingClientRect(),
      area = viewport.getBoundingClientRect()
    return !!rect && rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1
  }
  checks.restore = visible()
  checks.boundedDOM = document.querySelectorAll('[role="listitem"]').length < 100
  document
    .querySelector('[aria-current="true"]')!
    .dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }))
  await delay()
  viewport.scrollTo(0, 0)
  await delay()
  subtitlesStore.set(currentTimeMsAtom, 2_400_000)
  await delay()
  checks.manualScrollPreserved = viewport.scrollTop < 10
  const first = document.querySelector<HTMLButtonElement>('[role="listitem"] button')!
  first.click()
  await delay()
  checks.rowClickSeeks = seeks[0] === 0
  subtitlesStore.set(currentTimeMsAtom, 2_400_000)
  await delay()
  const resume = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("backToCurrent"),
  )
  checks.resumeAvailable = !!resume
  resume?.click()
  await delay(300)
  checks.resumeCurrent = visible()
  subtitlesStore.set(
    translatedTrackAtom,
    source.slice(1195, 1210).map((cue) => ({ ...cue, translation: "增加译文行高。".repeat(20) })),
  )
  await delay(300)
  checks.variableHeight = !!document.querySelector('[aria-current="true"]')
  subtitlesStore.set(currentTimeMsAtom, 2120000)
  await delay(300)
  checks.backwardSeek = visible()
  return {
    checks,
    scales: [],
    seeks,
    mountedRows: document.querySelectorAll('[role="listitem"]').length,
  }
}
