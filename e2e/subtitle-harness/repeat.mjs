import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

// Run sequentially on an idle machine. Alternating order limits warm-machine bias.
const exec = promisify(execFile)
const baseline = resolve(process.argv[2])
const candidate = resolve(process.argv[3] ?? ".")
const output = resolve(
  process.argv[4] ?? "docs/lite/resource-scheduler/convergence-evidence/repeated",
)
const sources = {
  baseline,
  candidate,
  ...(process.argv[5] ? { historical: resolve(process.argv[5]) } : {}),
}
const commits = {}
for (const [name, source] of Object.entries(sources))
  commits[name] = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim()
await mkdir(output, { recursive: true })
const samples = []
for (let pair = 0; pair < 5; pair++) {
  const names = Object.keys(sources)
  const order = [...names.slice(pair % names.length), ...names.slice(0, pair % names.length)]
  if (pair % 2) order.reverse()
  for (const name of order) {
    const source = sources[name]
    for (const kind of ["timeline", "export"]) {
      const destination = `${output}/${kind}-${name}-${pair + 1}`
      const { stdout, stderr } = await exec(
        process.execPath,
        ["e2e/subtitle-harness/run.mjs", source, destination],
        {
          env: {
            ...process.env,
            BENCHMARK_KIND: kind,
            BENCHMARK_REPEATS: kind === "timeline" ? "50" : "10",
            BENCHMARK_SIZES: kind === "timeline" ? "10000,50000" : "10000",
          },
          maxBuffer: 4 * 1024 * 1024,
        },
      )
      await writeFile(`${destination}/run.txt`, stdout + stderr)
      samples.push({
        pair: pair + 1,
        name,
        kind,
        raw: JSON.parse(await readFile(`${destination}/raw.json`, "utf8")),
      })
      console.log(`Completed pair ${pair + 1}: ${name} ${kind}`)
    }
  }
}
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const stats = (values) => ({
  n: values.length,
  p50: quantile(values, 0.5),
  p95: quantile(values, 0.95),
  min: Math.min(...values),
  max: Math.max(...values),
})
const summary = []
for (const name of Object.keys(sources)) {
  for (const kind of ["timeline", "export"]) {
    for (const size of kind === "timeline" ? [10000, 50000] : [10000]) {
      const runs = samples
        .filter((s) => s.name === name && s.kind === kind)
        .map(({ pair, raw }) => {
          const scale = raw.scales.find((s) => s.size === size)
          const values = kind === "timeline" ? scale.bulk500 : scale.samples.map((s) => s.duration)
          return {
            pair,
            values,
            all: stats(values),
            first: values[0],
            subsequent: stats(values.slice(1)),
          }
        })
      summary.push({
        name,
        kind,
        size,
        all: stats(runs.flatMap((r) => r.values)),
        subsequent: stats(runs.flatMap((r) => r.values.slice(1))),
        first: runs.map((r) => r.first),
        runs,
      })
    }
  }
}
await writeFile(
  `${output}/summary.json`,
  JSON.stringify(
    {
      sources,
      commits,
      methodology:
        "Five fresh-browser rounds per revision, rotating/reversing revision order, sequential execution. Nearest-rank quantiles; cold samples retained and reported separately. All requests local Mock.",
      summary,
    },
    null,
    2,
  ),
)
console.log(
  JSON.stringify(
    summary.map(({ runs: _runs, ...row }) => row),
    null,
    2,
  ),
)
