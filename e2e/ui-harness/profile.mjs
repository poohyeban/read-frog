import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
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
    await page.addInitScript(installBrowserAPI, { config, backgroundDelay: 10 })
    await page.goto(`${server.url}/popup.html`)
    await page.waitForFunction(() => window.__uiTrace.interactive)
    await page.evaluate(() => document.fonts.ready)
    // Two animation frames settle the initial Jotai effects before measuring an edit.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    )
    const initial = await page.evaluate(() => ({
      profiles: window.__uiProfiles,
      phases: window.__uiPhases,
      moduleReady: window.__uiModuleReady,
      trace: window.__uiTrace,
    }))
    await page.evaluate(() => {
      window.__uiProfiles = []
    })
    await page.getByRole("switch").last().press("Space")
    await page.waitForFunction(
      () => window.__uiTrace.calls.filter((c) => c.name === "storage.set" && c.end).length >= 2,
    )
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    )
    results.push({ sample, initial, edit: await page.evaluate(() => window.__uiProfiles) })
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
}
await writeFile(
  `${output}/profiles.json`,
  JSON.stringify(
    {
      note: "React production profiling build, 5 samples, NOT normal-production startup timings. Profile tuples: id, phase, actualDuration, baseDuration, startTime, commitTime.",
      results,
    },
    null,
    2,
  ),
)
console.log(
  results.map((r) => ({
    sample: r.sample,
    moduleReady: r.initial.moduleReady,
    root: r.initial.profiles?.filter((p) => p[0] === "Root"),
    edit: r.edit?.filter((p) => p[0] === "ProvidersField"),
  })),
)
