import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { chromium } from "@playwright/test"
import { installBrowserAPI } from "./browser-api.mjs"
import { serveBuild } from "./serve.mjs"
const root = resolve(process.argv[2])
const output = resolve(process.argv[3])
await mkdir(output, { recursive: true })
const config = JSON.parse(await readFile("/tmp/read-frog-ui-fixture/config.json", "utf8"))
config.uiLanguage = "en"
const server = await serveBuild(root)
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
})
const results = []
try {
  for (let sample = 0; sample < 5; sample++) {
    const context = await browser.newContext({
      viewport: { width: 320, height: 600 },
      reducedMotion: "reduce",
    })
    const page = await context.newPage()
    await page.addInitScript(installBrowserAPI, { config })
    const cdp = await context.newCDPSession(page)
    const events = []
    cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value))
    const complete = new Promise((done) => cdp.once("Tracing.tracingComplete", done))
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,v8,disabled-by-default-v8.compile,blink.user_timing",
      options: "record-as-much-as-possible",
      transferMode: "ReportEvents",
    })
    await page.goto(`${server.url}/popup.html`)
    await page.waitForFunction(() => window.__uiTrace.interactive)
    await cdp.send("Tracing.end")
    await complete
    const groups = {}
    for (const e of events) {
      if (e.ph !== "X" || !e.dur || !/(compile|parse|EvaluateScript|FunctionCall)/i.test(e.name))
        continue
      const key = `${e.name} (${e.pid}:${e.tid})`
      const row = (groups[key] ??= { name: e.name, pid: e.pid, tid: e.tid, count: 0, ms: 0 })
      row.count++
      row.ms += e.dur / 1000
    }
    results.push({ sample, groups: Object.values(groups).sort((a, b) => b.ms - a.ms) })
    await writeFile(
      `${output}/trace-${sample}.json.gz`,
      gzipSync(JSON.stringify({ traceEvents: events })),
    )
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
}
await writeFile(
  `${output}/summary.json`,
  JSON.stringify(
    {
      note: "5 separate traced normal-production loads. Event durations are inclusive and may overlap; background threads are reported separately. Never add these to wall-clock startup or compare traced startup with untraced samples.",
      results,
    },
    null,
    2,
  ),
)
console.log(results[0].groups.slice(0, 12))
