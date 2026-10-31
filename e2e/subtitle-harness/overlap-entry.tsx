import { CueTimeline } from "@/utils/subtitles/cue-timeline"
;(window as any).runSubtitleBenchmark = async () => {
  const source = Array.from({ length: 50000 }, (_, i) => ({
    start: i * 216 + 1,
    end: i * 216 + 200,
    text: String(i),
  }))
  const cues = [{ start: 0, end: 10800000, text: "long" }, ...source]
  const stamp = performance.now()
  const timeline = new CueTimeline(cues)
  const constructionMs = performance.now() - stamp
  const lookup: number[] = [],
    windows: number[] = []
  let incorrect = 0
  for (let sample = 0; sample < 50; sample++) {
    let start = performance.now()
    for (let i = 0; i < 100; i++) {
      const cue = source[((sample * 100 + i) * 7919) % source.length]!
      if (timeline.at(cue.start + 1) !== cue) incorrect++
    }
    lookup.push((performance.now() - start) / 100)
    start = performance.now()
    for (let i = 0; i < 100; i++) {
      const time = ((sample * 100 + i) * 7919) % 10700000
      timeline.window(time, time + 1000, 128)
    }
    windows.push((performance.now() - start) / 100)
  }
  return {
    size: source.length,
    durationMs: 10800000,
    constructionMs,
    lookup,
    windows,
    incorrect,
    providerStarts: 0,
    ipc: 0,
    reactCommits: 0,
    actualUsage: null,
    heapBytes: (performance as any).memory?.usedJSHeapSize,
    note: "Actual CueTimeline in Chromium; 5000 random/reverse seeks with one full-video cue. No Provider or React work.",
  }
}
