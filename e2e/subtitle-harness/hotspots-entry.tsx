import { translatedTrackAtom, subtitlesStore } from "@/entrypoints/subtitles.content/atoms"
import { SubtitlesScheduler } from "@/entrypoints/subtitles.content/subtitles-scheduler"
import { cueIdentity } from "@/utils/subtitles/cue-timeline"
import { buildTranscript } from "@/utils/subtitles/transcript"
;(window as any).runSubtitleBenchmark = async () => {
  const size = 50000
  const source = Array.from({ length: size }, (_, i) => ({
    start: i * 216,
    end: i * 216 + 200,
    text: `Sentence ${i} with enough words to represent a normal subtitle.`,
  }))
  const identities: number[] = [],
    incremental: number[] = [],
    projection: number[] = [],
    heaps: number[] = []
  const renderer = new SubtitlesScheduler({ videoElement: document.createElement("video") })
  renderer.supplementSubtitles(source.map((c) => ({ ...c, translation: `T:${c.text}` })))
  let lines = buildTranscript(source, subtitlesStore.get(translatedTrackAtom))
  let unchanged = true
  for (let sample = 0; sample < 30; sample++) {
    let stamp = performance.now()
    for (const cue of source) cueIdentity(cue)
    identities.push(performance.now() - stamp)
    const updates = source
      .slice(sample * 5, sample * 5 + 5)
      .map((c) => ({ ...c, translation: `${sample}:${c.text}` }))
    const old = lines[49999]
    stamp = performance.now()
    renderer.supplementSubtitles(updates)
    const projected = performance.now()
    lines = buildTranscript(source, subtitlesStore.get(translatedTrackAtom))
    projection.push(performance.now() - projected)
    incremental.push(performance.now() - stamp)
    unchanged &&= lines[49999] === old
    heaps.push((performance as any).memory?.usedJSHeapSize)
  }
  renderer.reset()
  renderer.stop()
  return {
    size,
    identities,
    incremental,
    projection,
    heaps,
    unchanged,
    providerStarts: 0,
    ipc: 0,
    reactCommits: 0,
    actualUsage: null,
    note: "Actual scheduler, atom publication and transcript projection; 30 five-member updates on 50,000 cues. No DOM list is mounted, so React commits = 0; separate transcript benchmark measures rendering.",
  }
}
