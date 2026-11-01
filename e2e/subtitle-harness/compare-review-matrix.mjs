import { readFile, writeFile } from "node:fs/promises"
import { gunzipSync } from "node:zlib"
const root = process.argv[2] ?? "docs/lite/review-convergence/evidence"
const read = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  return JSON.parse(gunzipSync(await readFile(`${path}.gz`)).toString("utf8"))
}
const before = await read(
  "docs/lite/resource-scheduler/convergence-evidence/matrix-candidate/raw.json",
)
const after = await read("docs/lite/review-reliability/evidence/matrix/raw.json")
const traces = Object.fromEntries(
  await Promise.all(
    ["before", "after"].map(async (side) => [
      side,
      (await read(`${root}/matrix-trace-${side}/raw.json`)).samples,
    ]),
  ),
)
const control = (await read(`${root}/matrix-window-control/raw.json`)).samples
const scenarioKeys = [
  "rate",
  "concurrency",
  "latency",
  "density",
  "mode",
  "failure",
  "requestRate",
  "burst",
]
function traceStats(sample) {
  const started = sample.events.filter((event) => event.type === "translate:execute")
  const completed = new Set(
    sample.events.filter((event) => event.type === "translate:complete").map((event) => event.key),
  )
  // Fixture text is Sentence N.; keys have no escaped | separators.
  const members = started.flatMap((event) => event.key.replace(/^translate:[^:]*:/, "").split("|"))
  return {
    fastStarts: started.length,
    segmentationStarts: sample.events.filter((event) => event.type === "segment:execute").length,
    startedMembers: members.length,
    uniqueMembers: new Set(members).size,
    duplicateMembers: members.length - new Set(members).size,
    completedMembers: started
      .filter((event) => completed.has(event.key))
      .reduce((n, event) => n + event.count, 0),
    batchSizes: Object.fromEntries(
      [...new Set(started.map((event) => event.count))]
        .sort((a, b) => a - b)
        .map((count) => [count, started.filter((event) => event.count === count).length]),
    ),
    farthestMediaEnd: Math.max(...started.map((event) => event.end)),
  }
}
const rows = before.samples.map((old, index) => {
  const next = after.samples[index]
  if (scenarioKeys.some((key) => old[key] !== next[key]))
    throw new Error(`Mismatched scenario ${index}`)
  const changed = next.requests !== old.requests
  const a = traces.before.find((sample) => sample.caseIndex === index),
    b = traces.after.find((sample) => sample.caseIndex === index)
  const c = control.find((sample) => sample.caseIndex === index)
  if (
    changed &&
    (!a ||
      !b ||
      !c ||
      a.requests !== old.requests ||
      b.requests !== next.requests ||
      c.requests !== old.requests)
  )
    throw new Error(`Unreproduced scenario ${index}`)
  return {
    index,
    ...Object.fromEntries(scenarioKeys.map((key) => [key, next[key] ?? null])),
    before: old.requests,
    after: next.requests,
    delta: next.requests - old.requests,
    retryDelta: next.retries - old.retries,
    cacheHitDelta: next.cacheHits - old.cacheHits,
    readyBeforeDisplay: [old.readyBeforeDisplay, next.readyBeforeDisplay],
    replayNewRequests: [old.replayNewRequests, next.replayNewRequests],
    ...(changed
      ? { traceBefore: traceStats(a), traceAfter: traceStats(b), controlRequests: c.requests }
      : {}),
    reason: !changed
      ? "unchanged"
      : index === 155
        ? "eligible prefetch at backward-seek/stop boundary; cancelled before completion"
        : index === 49 || index === 97
          ? "more eligible unique members; fewer small batches; independent segmentation scheduling changes"
          : "112 additional unique completed Fast members beyond the former 128-source candidate cutoff",
  }
})
const summary = {
  scenarios: rows.length,
  changed: rows.filter((row) => row.delta).length,
  before: rows.reduce((n, row) => n + row.before, 0),
  after: rows.reduce((n, row) => n + row.after, 0),
  added: rows.reduce((n, row) => n + Math.max(0, row.delta), 0),
  removed: rows.reduce((n, row) => n + Math.max(0, -row.delta), 0),
  rows,
}
await writeFile(`${root}/matrix-comparison.json`, JSON.stringify(summary, null, 2))
const columns = [
  "index",
  ...scenarioKeys,
  "before",
  "after",
  "delta",
  "retryDelta",
  "cacheHitDelta",
  "reason",
]
await writeFile(
  `${root}/matrix-comparison.csv`,
  [
    columns.join(","),
    ...rows.map((row) => columns.map((key) => JSON.stringify(row[key] ?? "")).join(",")),
  ].join("\n") + "\n",
)
console.log(JSON.stringify({ ...summary, rows: undefined }))
