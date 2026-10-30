import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import process from "node:process"
import { chromium, expect, test } from "@playwright/test"
import { buildHarness } from "./translation-harness/build.mjs"

// Real Chromium DOM/layout with the production content pipeline. The fixture
// replaces extension storage/messaging only; MV3 transport remains an E2E concern.
test("translation architecture: reproducible cold/warm browser benchmark", async () => {
  test.setTimeout(300_000)
  const output = `/tmp/read-frog-browser-${process.env.PERF_LABEL || "upgrade"}`
  await buildHarness(process.env.PERF_SOURCE_ROOT || process.cwd(), output)
  const text =
    "This detailed English paragraph explains the behavior of tree frogs in their natural habitat and how researchers observe changes across different seasons."
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    if (req.method === "OPTIONS") return res.writeHead(204).end()
    if (req.url === "/") return res.writeHead(204).end()
    if (!req.url.startsWith("/article")) {
      try {
        const file = await readFile(resolve(output, req.url.slice(1)))
        res.setHeader("Content-Type", req.url.endsWith(".css") ? "text/css" : "text/javascript")
        return res.end(file)
      } catch {
        return res.writeHead(404).end()
      }
    }
    if (req.url.startsWith("/article")) {
      const params = new URL(req.url, "http://localhost").searchParams
      const variant = params.get("fixture") || "static"
      const seed = params.get("seed")
      let body = Array.from(
        { length: 600 },
        (_, i) => `<p id="p${i}">${text} Study ${seed}, paragraph ${i}.</p>`,
      ).join("")
      if (variant === "float")
        body =
          '<aside style="float:right;width:35%;height:1800px;background:#ddd">Research diagram</aside>' +
          body
      if (variant === "markdown")
        body =
          `<h1>Research report</h1><p><em>English emphasis</em> and a <a href="#note">reference</a> with <code>code</code>.</p><p><sub id="note" style="line-height:0">${text}</sub></p>` +
          body
      if (variant === "giant")
        body =
          `<div id="giant" style="white-space:pre-wrap">${Array.from({ length: 40 }, (_, i) => `${text} Giant unit ${i}`).join("\n\n")}</div>` +
          body
      const shadow =
        variant === "shadow"
          ? `<div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>${text}</p>'</script>`
          : ""
      res.setHeader("Content-Type", "text/html")
      return res.end(
        `<!doctype html><html lang="en"><head><title>Frog research ${seed}</title><style>body{max-width:900px;margin:20px auto;font:16px/1.5 sans-serif}p{margin:8px 0}</style><link rel="stylesheet" href="/_translation-entry.css"></head><body>${shadow}<main>${body}</main><script type="module" src="/entry.js"></script></body></html>`,
      )
    }

    return undefined
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const origin = `http://127.0.0.1:${server.address().port}`
  const results = {
    browser: "",
    source: process.env.PERF_LABEL || "upgrade",
    provider: "local mock, 80ms",
    samples: [],
  }
  let context
  let heapSampler
  try {
    context = await chromium.launchPersistentContext("", {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    })
    results.browser = context.browser().version()
    results.transport = "browser harness; simulated extension storage and messages"
    const runs = Number(process.env.PERF_RUNS || 5)
    for (const smart of [false, true]) {
      for (let trial = 0; trial < runs; trial++) {
        const page = await context.newPage()
        const errors = []
        page.on("pageerror", (error) => errors.push(error.message))
        const cdp = await context.newCDPSession(page)
        await cdp.send("Runtime.enable")
        await cdp.send("Performance.enable")
        await page.addInitScript(() => {
          window.__perf = { longTasks: [], frames: [], first: null, start: null, walks: 0 }
          window.__interactions = []
          addEventListener("keydown", (event) => {
            requestAnimationFrame(() =>
              window.__interactions.push(performance.now() - event.timeStamp),
            )
          })
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) window.__perf.longTasks.push(entry.duration)
          }).observe({ type: "longtask", buffered: true })
          let last = performance.now()
          const frame = (now) => {
            window.__perf.frames.push(now - last)
            last = now
            requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
          new MutationObserver((records) => {
            window.__perf.walks += records.filter(
              (r) => r.attributeName === "data-read-frog-walked",
            ).length
            if (
              window.__perf.start &&
              !window.__perf.first &&
              [...document.querySelectorAll(".read-frog-translated-content-wrapper")].some((n) =>
                n.textContent.includes("本地模拟译文"),
              )
            )
              window.__perf.first = performance.now() - window.__perf.start
          }).observe(document, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["data-read-frog-walked"],
          })
        })
        console.log("benchmark: opening page", smart, trial)
        await page.goto(`${origin}/article?seed=${smart}-${trial}&smart=${smart}`)
        await page.waitForFunction(() => Boolean(window.harness))
        expect(
          await page.evaluate(() =>
            [...document.styleSheets].some((sheet) =>
              sheet.href?.endsWith("/_translation-entry.css"),
            ),
          ),
        ).toBe(true)
        await page.evaluate(() => {
          window.__sourceMetrics = { reads: 0, extractions: 0 }
          const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")
          Object.defineProperty(Node.prototype, "textContent", {
            ...descriptor,
            get() {
              window.__sourceMetrics.reads++
              return descriptor.get.call(this)
            },
          })
          const create = DOMImplementation.prototype.createHTMLDocument.bind(
            document.implementation,
          )
          DOMImplementation.prototype.createHTMLDocument = function (...args) {
            window.__sourceMetrics.extractions++
            return create.apply(this, args)
          }
        })
        for (const cache of ["cold", "warm"]) {
          console.log("benchmark: measuring", smart, trial, cache)
          let sampledPeakHeapUsed = 0
          let sampling = false
          const sampleHeap = async () => {
            if (sampling) return
            sampling = true
            try {
              const { usedSize } = await cdp.send("Runtime.getHeapUsage")
              sampledPeakHeapUsed = Math.max(sampledPeakHeapUsed, usedSize)
            } finally {
              sampling = false
            }
          }
          await sampleHeap()
          heapSampler = setInterval(() => {
            void sampleHeap().catch(() => {})
          }, 25)
          const before = await page.evaluate(() => ({
            ...window.harness.metrics,
            ...window.__sourceMetrics,
          }))
          await page.evaluate(() => {
            Object.assign(window.__perf, {
              longTasks: [],
              frames: [],
              first: null,
              start: performance.now(),
              walks: 0,
            })
          })
          await page.evaluate(() => {
            void window.harness.manager.start()
          })
          await expect(page.locator("#p0 .read-frog-translated-content-wrapper")).toContainText(
            "本地模拟译文",
          )
          await page.waitForTimeout(250)
          const stats = await page.evaluate(() => ({
            ...window.__perf,
            wrappers: document.querySelectorAll(".read-frog-translated-content-wrapper").length,
          }))
          const localCounters = await page.evaluate(() => ({
            ...window.harness.metrics,
            ...window.__sourceMetrics,
          }))
          const metrics = (await cdp.send("Performance.getMetrics")).metrics
          await page.evaluate(() => {
            window.__perf.frames = []
            window.__interactions = []
          })
          await page.keyboard.press("PageDown")
          await page.waitForFunction(() => window.__interactions.length > 0 && scrollY > 0)
          await page.waitForTimeout(200)
          const interaction = await page.evaluate(() => ({
            keyToFrameMs: window.__interactions[0],
            scrollFrameGapMs: Math.max(...window.__perf.frames),
            scrollY,
          }))
          clearInterval(heapSampler)
          heapSampler = undefined
          await page.evaluate(() => window.harness.manager.stop())
          await expect(page.locator(".read-frog-translated-content-wrapper")).toHaveCount(0)
          await cdp.send("HeapProfiler.collectGarbage")
          const stoppedMetrics = (await cdp.send("Performance.getMetrics")).metrics
          results.samples.push({
            smart,
            trial,
            cache,
            firstVisibleMs: stats.first,
            longTasks: stats.longTasks,
            maxFrameGapMs: Math.max(...stats.frames),
            walks: stats.walks,
            wrappers: stats.wrappers,
            localCounters: {
              reads: localCounters.reads - before.reads,
              extractions: localCounters.extractions - before.extractions,
            },
            summaryMessages: localCounters.summaryMessages - before.summaryMessages,
            summaryCalls: localCounters.summaries - before.summaries,
            translationCalls: localCounters.translations - before.translations,
            persistentCacheHits: localCounters.cacheHits - before.cacheHits,
            sampledPeakHeapUsed,
            interaction,
            heapUsed: metrics.find((m) => m.name === "JSHeapUsedSize")?.value,
            heapAfterStop: stoppedMetrics.find((m) => m.name === "JSHeapUsedSize")?.value,
            errors,
          })
          expect(errors).toEqual([])
          expect(stats.first).toBeGreaterThan(0)
          await page.evaluate(() => scrollTo(0, 0))
          await page.waitForTimeout(50)
        }
        await page.close()
      }
    }
    results.compatibility = []
    for (const fixture of [
      "float",
      "markdown",
      "shadow",
      "giant",
      "spa",
      "virtual",
      "mutation",
      "pending-mutation",
    ]) {
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(`${origin}/article?fixture=${fixture}&seed=${fixture}&smart=true`)
      await page.waitForFunction(() => Boolean(window.harness))
      expect(
        await page.evaluate(() =>
          [...document.styleSheets].some((sheet) =>
            sheet.href?.endsWith("/_translation-entry.css"),
          ),
        ),
      ).toBe(true)
      await page.evaluate(() => {
        void window.harness.manager.start()
      })
      if (fixture === "pending-mutation") {
        await page.evaluate(() => {
          setTimeout(() => {
            const added = document.createElement("p")
            added.textContent =
              "A newly added English paragraph arrived while the shared page summary was still pending."
            document.querySelector("main").append(added)
          }, 20)
        })
      }
      if (fixture === "giant") {
        await expect(
          page.locator("#giant .read-frog-translated-content-wrapper").first(),
        ).toContainText("本地模拟译文")
      } else {
        await expect(page.locator("#p0 .read-frog-translated-content-wrapper")).toContainText(
          "本地模拟译文",
        )
      }
      if (fixture === "shadow")
        await expect(page.locator("#shadow .read-frog-translated-content-wrapper")).toContainText(
          "本地模拟译文",
        )
      if (fixture === "float") {
        const gap = await page.locator("#p0").evaluate((element) => {
          const wrapper = element.querySelector(".read-frog-translated-content-wrapper")
          return wrapper.getBoundingClientRect().top - element.getBoundingClientRect().top
        })
        expect(gap).toBeLessThan(300)
      }
      if (fixture === "markdown") {
        await expect(page.locator("#note .read-frog-translated-content-wrapper")).toContainText(
          "本地模拟译文",
        )
        const height = await page
          .locator("#note .read-frog-translated-content-wrapper")
          .evaluate((element) => element.getBoundingClientRect().height)
        expect(height).toBeGreaterThan(0)
      }
      if (fixture === "spa" || fixture === "virtual") {
        await page.evaluate(async (kind) => {
          if (kind === "spa") {
            history.pushState({}, "", "?route=page-b")
            await window.harness.manager.refreshSiteRuleCSS()
          }
          document.querySelector("main").innerHTML =
            '<p id="replacement">This is the new English article after the application replaced its content with a different subject.</p>'
        }, fixture)
        await expect(
          page.locator("#replacement .read-frog-translated-content-wrapper"),
        ).toContainText("本地模拟译文")
      }
      if (fixture === "mutation") {
        await page.locator("#p0").evaluate((element) => {
          for (let i = 0; i < 30; i++) element.firstChild.data += ` Updated detail ${i}.`
        })
        await expect(page.locator("#p0 .read-frog-translated-content-wrapper")).toHaveCount(1)
        await expect(page.locator("#p0 .read-frog-translated-content-wrapper")).toContainText(
          "本地模拟译文",
        )
      }
      await page.evaluate(() => window.harness.manager.stop())
      await expect(page.locator(".read-frog-translated-content-wrapper")).toHaveCount(0)
      // Complete-result translation-only mode must restore the exact source.
      const original = await page.locator("main").textContent()
      await page.evaluate(async () => {
        window.harness.config.pageTranslation.mode = "translationOnly"
        await window.harness.update()
        void window.harness.manager.start()
      })
      await expect(page.locator("main")).toContainText("本地模拟译文")
      await page.evaluate(() => window.harness.manager.stop())
      const restored = await page.locator("main").textContent()
      if (restored !== original)
        results.compatibility.push({
          fixture,
          passed: false,
          phase: "translationOnly restore",
          expectedLength: original.length,
          actualLength: restored.length,
        })
      await expect
        .poll(async () => (await page.locator("main").textContent()) === original)
        .toBe(true)
      expect(errors).toEqual([])
      results.compatibility.push({ fixture, passed: true })
      await page.close()
    }
  } finally {
    clearInterval(heapSampler)
    const dir = resolve(process.env.PERF_OUTPUT_DIR || "test-results/translation-performance")
    await mkdir(dir, { recursive: true })
    await writeFile(`${dir}/${results.source}.json`, JSON.stringify(results, null, 2))
    await context?.close()
    await new Promise((done) => server.close(done))
  }
})
