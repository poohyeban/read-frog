// @vitest-environment jsdom
import type { ViewUpdate } from "@codemirror/view"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { Profiler } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { JSONCodeEditor } from "@/components/ui/json-code-editor"
import LanguageOptionsSelector from "@/entrypoints/popup/components/language-options-selector"
import {
  currentTimeMsAtom,
  sourceTrackAtom,
  translatedTrackAtom,
} from "@/entrypoints/subtitles.content/atoms"
import { TranscriptSection } from "@/entrypoints/subtitles.content/ui/subtitles-sidebar/sections/transcript"
import { SubtitlesUIContext } from "@/entrypoints/subtitles.content/ui/subtitles-ui-context"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { percentiles, report } from "./report"

vi.mock("@/components/providers/theme-provider", () => ({ useTheme: () => ({ theme: "light" }) }))
vi.mock("@/utils/atoms/storage-adapter", () => ({
  storageAdapter: {
    get: async () => structuredClone(DEFAULT_CONFIG),
    watch: () => () => {},
  },
}))
afterEach(cleanup)

it("records React Profiler commits for reproducible local UI interactions", async () => {
  Element.prototype.scrollIntoView = () => {}
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList
  const results: Record<string, unknown> = {}
  let commits: { phase: string; actualDuration: number; baseDuration: number }[] = []
  const onRender = (_id: string, phase: string, actualDuration: number, baseDuration: number) =>
    commits.push({ phase, actualDuration, baseDuration })
  const capture = (name: string) => {
    results[name] = {
      commits: [...commits],
      count: commits.length,
      actualDuration: percentiles(commits.map((commit) => commit.actualDuration)),
    }
    commits = []
  }
  const popupStore = createStore()
  await act(async () => {
    render(
      <Provider store={popupStore}>
        <Profiler id="popup-language" onRender={onRender}>
          <LanguageOptionsSelector />
        </Profiler>
      </Provider>,
    )
  })
  for (let iteration = -3; iteration < 30; iteration++) {
    if (iteration === 0) commits = []
    const next = structuredClone(DEFAULT_CONFIG)
    next.pageTranslation.page.preload.margin += iteration + 10
    await act(async () => {
      popupStore.set(configAtom, next)
    })
  }
  capture("popup-language-unrelated-config-updates")
  cleanup()

  let reconfigurations = 0
  const onUpdate = (update: ViewUpdate) => {
    reconfigurations += update.transactions.filter((transaction) => transaction.reconfigured).length
  }
  const onChange = () => {}
  const editor = (hasError: boolean) => (
    <Profiler id="provider-json" onRender={onRender}>
      <JSONCodeEditor
        value={'{"key":1}'}
        hasError={hasError}
        onChange={onChange}
        onUpdate={onUpdate}
      />
    </Profiler>
  )
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(editor(false))
  })
  for (let iteration = -3; iteration < 30; iteration++) {
    if (iteration === 0) {
      commits = []
      reconfigurations = 0
    }
    await act(async () => {
      view.rerender(editor(iteration % 2 === 0))
    })
  }
  capture("provider-json-error-decoration-updates")
  results["provider-json-reconfiguration-count"] = reconfigurations
  cleanup()

  const store = createStore()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const source = Array.from({ length: 500 }, (_, index) => ({
    start: index * 1000,
    end: index * 1000 + 800,
    text: `Subtitle ${index}`,
  }))
  store.set(sourceTrackAtom, source)
  store.set(currentTimeMsAtom, 0)
  const ui = { ensureSourceTrackPublished: async () => {}, seekTo: () => {} }
  await act(async () => {
    render(
      <Provider store={store}>
        <QueryClientProvider client={client}>
          <SubtitlesUIContext value={ui as never}>
            <Profiler id="transcript" onRender={onRender}>
              <TranscriptSection />
            </Profiler>
          </SubtitlesUIContext>
        </QueryClientProvider>
      </Provider>,
    )
  })
  for (let iteration = -3; iteration < 30; iteration++) {
    if (iteration === 0) commits = []
    await act(async () => {
      store.set(translatedTrackAtom, [{ ...source[20]!, translation: `Translation ${iteration}` }])
    })
  }
  capture("transcript-single-cue-translation-500-rows")
  expect(view).toBeDefined()
  cleanup()
  client.clear()
  await report(`ui-${process.env.PERF_LABEL ?? "current"}`, {
    caveat:
      "React development Profiler in jsdom. Relative commits/reconfiguration work only; these durations are not production browser latency.",
    warmups: 3,
    measuredInteractions: 30,
    results,
  })
})
