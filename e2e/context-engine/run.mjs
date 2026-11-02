import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve, dirname } from "node:path"
import { chromium } from "@playwright/test"
import react from "@vitejs/plugin-react"
import { build } from "vite"
const source = resolve(process.argv[3] || ".", "src")
const harness = resolve("e2e/translation-harness")
const output = `/tmp/context-v2-browser-${process.pid}`
const destination = resolve(process.argv[2] || "/tmp/context-v2-browser.json")
const replacements = new Map([
  [resolve(source, "utils/message"), resolve("e2e/context-engine/messages.ts")],
  [resolve(source, "utils/i18n"), `${harness}/i18n.js`],
  [resolve(source, "utils/i18n/locale-boundary"), `${harness}/i18n.js`],
])
await build({
  configFile: false,
  logLevel: "warn",
  resolve: { alias: { "@": source, "#imports": `${harness}/runtime.js` } },
  plugins: [
    react(),
    {
      name: "context-browser",
      enforce: "pre",
      resolveId(id, importer) {
        const absolute = id.startsWith("@/")
          ? resolve(source, id.slice(2))
          : id.startsWith(".") && importer
            ? resolve(dirname(importer), id)
            : id
        return replacements.get(absolute)
      },
    },
  ],
  build: {
    target: "esnext",
    outDir: output,
    emptyOutDir: true,
    minify: true,
    rollupOptions: {
      input: resolve("e2e/context-engine/entry.ts"),
      output: {
        entryFileNames: "entry.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
})
let requests = 0
let gates = []
let hold = true
const server = createServer(async (req, res) => {
  if (req.url === "/mock") {
    for await (const _chunk of req) {
      /* Local fixture body is intentionally not logged. */
    }
    requests++
    if (hold) await new Promise((done) => gates.push(done))
    res.end("译文：这是完整的本地模拟结果，用于验证原文所有权和显示行为。")
    return
  }
  if (req.url === "/") {
    res.setHeader("content-type", "text/html")
    res.end(
      '<html><head><title>Context fixture</title></head><body><script type="module" src="/entry.js"></script></body></html>',
    )
    return
  }
  try {
    res.setHeader("content-type", req.url.endsWith(".css") ? "text/css" : "text/javascript")
    res.end(await readFile(resolve(output, req.url.slice(1))))
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
})
const result = {
  browser: browser.version(),
  kind: "Real Chromium DOM + local HTTP mock transport; SDK/queues verified separately",
  cases: [],
  hardening: [],
  lifetime: [],
}
const release = () => {
  hold = false
  gates.splice(0).forEach((done) => done())
}
try {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => window.contextBrowser)
  for (const mode of ["bilingual", "translationOnly"])
    for (const { units, giant } of [
      { units: 1, giant: false },
      { units: 6, giant: false },
      { units: 6, giant: true },
    ]) {
      hold = true
      const before = requests
      await page.evaluate(
        async ({ mode: displayMode, units: count, giant: oversized }) => {
          window.pendingFixture = await window.contextBrowser.fixture(
            displayMode,
            count,
            false,
            oversized,
          )
        },
        { mode, units, giant },
      )
      await page.waitForFunction((count) => window.contextBrowser.metrics.requests === count, units)
      const partialBeforeRemoval = units === 6 && !giant
      if (partialBeforeRemoval) {
        const deadline = Date.now() + 5000
        while (gates.length < units) {
          if (Date.now() > deadline) throw new Error("Missing held HTTP members")
          await new Promise((done) => setTimeout(done, 10))
        }
        gates.shift()()
        await page.waitForFunction(
          () => (document.querySelector("#a").textContent.match(/译文：/g) || []).length === 1,
        )
      }
      await page.evaluate(() => document.querySelector("#b").remove())
      release()
      await page.evaluate(() => window.pendingFixture.task)
      await page.waitForFunction(
        (count) =>
          (document.querySelector("#a").textContent.match(/译文：/g) || []).length === count,
        units,
      )
      const translated = await page.locator("#a").textContent()
      if ((translated.match(/译文：/g) || []).length !== units)
        throw new Error(`Missing ${mode}/${units} results`)
      const calls = requests - before
      if (calls !== units) throw new Error(`Unexpected HTTP ${calls}/${units}`)
      result.cases.push({
        mode,
        units,
        giant,
        unrelatedRemoval: true,
        partialBeforeRemoval,
        http: calls,
      })
    }
  // Real PageTranslationManager.stop(), with an offscreen independent operation.
  for (const mode of ["bilingual", "translationOnly"]) {
    hold = true
    const before = requests
    await page.evaluate(async (displayMode) => {
      const api = window.contextBrowser
      await api.reset(displayMode)
      document.body.innerHTML =
        '<article style="position:absolute;top:10000px"><h2>Manual source</h2><p id="manual">This independent original paragraph remains valid after page translation is stopped.</p></article>'
      await api.manager.start()
      window.manualTask = api.manual(document.querySelector("#manual"))
    }, mode)
    await page.waitForFunction(() => window.contextBrowser.metrics.requests === 1)
    await page.evaluate(() => window.contextBrowser.manager.stop())
    release()
    await page.evaluate(() => window.manualTask)
    await page.waitForFunction(() =>
      document.querySelector("#manual").textContent.includes("译文："),
    )
    if (!(await page.locator("#manual").textContent()).includes("译文："))
      throw new Error(`Manual ${mode} lost on stop`)
    result.cases.push({ mode, manualAfterFullPageStop: true, http: requests - before })
  }
  // Independent negative control: an edited source must reject its held result.
  for (const mode of ["bilingual", "translationOnly"]) {
    hold = true
    const before = requests
    await page.evaluate(async (displayMode) => {
      window.pendingFixture = await window.contextBrowser.fixture(
        displayMode,
        1,
        false,
        false,
        "edited-negative",
      )
    }, mode)
    await page.waitForFunction(() => window.contextBrowser.metrics.requests === 1)
    await page.evaluate(() => {
      document.querySelector("#a").textContent = "Edited original source while request was pending."
    })
    release()
    await page.evaluate(() => window.pendingFixture.task)
    if ((await page.locator("#a").textContent()).includes("译文："))
      throw new Error("Old result committed on edited source")
    result.hardening.push({ mode, sourceEdited: true, http: requests - before })
  }
  const beforeContextOnly = requests
  const precise = await page.evaluate(async () => {
    const api = window.contextBrowser
    await api.reset("bilingual")
    document.body.innerHTML =
      '<main role="feed"><article id="a"><h2>A heading</h2><p>A original source</p></article><article id="b"><p>B source</p></article></main>'
    const contextSource = document.querySelector("#a"),
      b = document.querySelector("#b")
    const read = () =>
      api.context.getOrCreateWebPageContext(true, undefined, { source: contextSource })
    const initial = await read(),
      before = api.context.getContextDiagnostics()
    for (let index = 0; index < 1000; index++) {
      contextSource.className = index % 2 ? "arbitrary-decoration" : "hover"
      contextSource.style.color = index % 2 ? "red" : "blue"
      b.textContent = `Other update ${index}`
      if ((await read()) !== initial) throw new Error("Cosmetic mutation rebuilt snapshot")
    }
    const after = api.context.getContextDiagnostics()
    if (after.projections !== before.projections)
      throw new Error("Cosmetic changes reprojected source")
    contextSource.style.opacity = "0"
    if ((await read()).webContent.includes("A original"))
      throw new Error("Transparent source leaked")
    contextSource.style.opacity = "0.5"
    if (!(await read()).webContent.includes("A original")) throw new Error("Readable opacity lost")
    contextSource.setAttribute("inert", "")
    if ((await read()).webContent.includes("A original")) throw new Error("Inert source leaked")
    contextSource.removeAttribute("inert")
    contextSource.style.contentVisibility = "hidden"
    if ((await read()).webContent.includes("A original"))
      throw new Error("content-visibility leaked")
    contextSource.style.contentVisibility = "auto"
    if (!(await read()).webContent.includes("A original"))
      throw new Error("content-visibility auto lost")
    api.cleanup()
    return {
      iterations: 1000,
      projectionDelta: after.projections - before.projections,
      rebuildDelta: after.rebuilds - before.rebuilds,
      staleDelta: after.stalePreparations - before.stalePreparations,
      summaryRPCs: api.metrics.summaryRPCs,
      after: api.context.getContextDiagnostics(),
    }
  })
  precise.http = requests - beforeContextOnly
  if (precise.http !== 0 || precise.summaryRPCs !== 0)
    throw new Error("DOM observation issued a model request")
  result.hardening.push(precise)
  await page.evaluate(() => window.contextBrowser.cleanup())
  await page.close()
  for (let tab = 0; tab < 2; tab++) {
    const lifetimePage = await browser.newPage()
    await lifetimePage.goto(`http://127.0.0.1:${server.address().port}/`)
    await lifetimePage.waitForFunction(() => window.contextBrowser)
    const measured = await lifetimePage.evaluate(async () => {
      const api = window.contextBrowser
      let peak = 0
      for (let cycle = 0; cycle < 100; cycle++) {
        document.body.innerHTML =
          '<main role="feed">' +
          Array.from(
            { length: 100 },
            (_, i) => `<article><p>Original source ${cycle} ${i}</p></article>`,
          ).join("") +
          "</main>"
        for (const sourceNode of [...document.querySelectorAll("p")].slice(0, 15))
          await api.context.getOrCreateWebPageContext(true, undefined, { source: sourceNode })
        peak = Math.max(peak, api.context.getContextDiagnostics().scopes)
      }
      api.cleanup()
      return { cycles: 100, acquired: 1500, peak, after: api.context.getContextDiagnostics() }
    })
    if (
      measured.peak > 128 ||
      measured.after.scopes !== 0 ||
      measured.after.invalidation.observers !== 0
    )
      throw new Error("Scope lifetime failed to converge")
    result.lifetime.push(measured)
    await lifetimePage.close()
  }
  result.totalHTTP = requests
} finally {
  release()
  await browser.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, JSON.stringify(result, null, 2) + "\n")
}
console.log(
  JSON.stringify({
    cases: result.cases.length,
    http: result.totalHTTP,
    lifetime: result.lifetime.length,
  }),
)
