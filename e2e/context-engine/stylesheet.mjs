import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve, dirname } from "node:path"
import { chromium } from "@playwright/test"
import react from "@vitejs/plugin-react"
import { build } from "vite"
const source = resolve(process.argv[3] || ".", "src")
const harness = resolve("e2e/translation-harness")
const output = `/tmp/context-stylesheet-browser-${process.pid}`
const destination = resolve(process.argv[2] || "/tmp/context-stylesheet-browser.json")
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
let sequence = 0
const pendingCSS = new Map()
const models = []
let cssRequests = 0
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://local")
  if (url.pathname === "/mock") {
    let body = ""
    for await (const chunk of req) body += chunk
    models.push(JSON.parse(body))
    res.end("译文：本地样式表隐私验证结果。")
    return
  }
  if (url.pathname.endsWith(".css")) {
    cssRequests++
    if (url.pathname === "/missing.css") {
      res.writeHead(404).end()
      return
    }
    if (url.searchParams.has("delay"))
      await new Promise((done) => pendingCSS.set(url.searchParams.get("delay"), done))
    res.setHeader("content-type", "text/css")
    res.end(
      url.pathname.includes("hidden")
        ? ".secret { display:none !important }"
        : ".secret { color:blue }",
    )
    return
  }
  if (req.url === "/") {
    res.setHeader("content-type", "text/html")
    res.end(
      '<html><head><title>Stylesheet fixture</title></head><body><script type="module" src="/entry.js"></script></body></html>',
    )
    return
  }
  try {
    res.setHeader("content-type", "text/javascript")
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
const report = {
  source,
  browser: browser.version(),
  cases: [],
  boundaries: [],
  modelHTTP: 0,
  cssHTTP: 0,
}
const page = await browser.newPage()
const check = async (name, test, boundary = false) => {
  const before = models.length
  try {
    const details = await test()
    ;(boundary ? report.boundaries : report.cases).push({
      name,
      status: "passed",
      modelHTTP: models.length - before,
      ...details,
    })
  } catch (error) {
    report.cases.push({
      name,
      status: "failed",
      error: error.message,
      modelHTTP: models.length - before,
    })
  }
}
const reset = async () =>
  page.evaluate(async () => {
    const api = window.contextBrowser
    await api.reset("bilingual")
    document.querySelectorAll("[data-stylesheet-fixture]").forEach((node) => node.remove())
    document.adoptedStyleSheets = []
    document.body.innerHTML =
      '<main role="feed"><article id="a"><h2>Safe topic</h2><p id="source">BENIGN_ENGLISH_SOURCE</p><div class="secret">PRIVATE_CONTEXT_SENTINEL</div></article><article id="b"><p>Unrelated source</p></article></main>'
    window.readStyleContext = () =>
      api.context.getOrCreateWebPageContext(true, undefined, {
        source: document.querySelector("#a"),
      })
  })
const link = async (href, attributes = {}) =>
  page.evaluate(
    async ({ href: path, attributes: attrs }) => {
      const node = document.createElement("link")
      node.dataset.stylesheetFixture = ""
      node.id = "test-css"
      node.rel = "stylesheet"
      node.href = path
      Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value))
      const loaded = new Promise((done) => {
        node.addEventListener("load", done, { once: true })
        node.addEventListener("error", done, { once: true })
      })
      document.head.append(node)
      await loaded
    },
    { href, attributes },
  )
const expectContext = async (visible) =>
  page.evaluate(async (expected) => {
    const context = await window.readStyleContext()
    const includes = context.webContent.replaceAll("\\", "").includes("PRIVATE_CONTEXT_SENTINEL")
    if (includes !== expected)
      throw new Error(
        `Context visible=${includes}; expected ${expected}; computed=${getComputedStyle(document.querySelector(".secret")).display}`,
      )
    return { identity: context.identity }
  }, visible)
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => window.contextBrowser)
  await check("href delayed load: old read during load, fresh prompt after load", async () => {
    await reset()
    await link("/visible.css")
    await expectContext(true)
    await page.evaluate(() =>
      window.contextBrowser.translate(
        "INITIAL distinct English translation.",
        document.querySelector("#source"),
      ),
    )
    const id = String(++sequence)
    await page.evaluate((gateId) => {
      document.querySelector("#test-css").href = `/hidden.css?delay=${gateId}`
    }, id)
    await expectContext(true)
    await page.waitForFunction(() => document.querySelector("#test-css").href.includes("delay="))
    const deadline = Date.now() + 10000
    while (!pendingCSS.has(id)) {
      if (Date.now() > deadline) throw new Error("CSS server gate never entered")
      await new Promise((done) => setTimeout(done, 10))
    }
    await page.evaluate(() => {
      window.styleFixtureLoaded = false
      document.querySelector("#test-css").addEventListener(
        "load",
        () => {
          window.styleFixtureLoaded = true
        },
        { once: true },
      )
    })
    pendingCSS.get(id)()
    pendingCSS.delete(id)
    await page.waitForFunction(() => window.styleFixtureLoaded)
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".secret")).display === "none",
    )
    await page.evaluate(() =>
      window.contextBrowser.translate(
        "AFTER distinct English translation.",
        document.querySelector("#source"),
      ),
    )
    const sent = models.at(-1)
    if (JSON.stringify(sent).replaceAll("\\", "").includes("PRIVATE_CONTEXT_SENTINEL"))
      throw new Error("A new physical HTTP request contains hidden context after stylesheet load")
    await expectContext(false)
    return {
      summaryRPCs: await page.evaluate(() => window.contextBrowser.metrics.summaryRPCs),
      resources: await page.evaluate(() => window.contextBrowser.context.getContextDiagnostics()),
    }
  })
  for (const kind of [
    "rel-out",
    "rel-in",
    "media",
    "disabled-idl",
    "disabled-attribute",
    "style-media",
    "style-text",
    "remove",
    "insert",
  ])
    await check(kind, async () => {
      await reset()
      if (["style-media", "style-text"].includes(kind)) {
        await page.evaluate((scenario) => {
          const style = document.createElement("style")
          style.dataset.stylesheetFixture = ""
          style.id = "test-css"
          style.media = scenario === "style-media" ? "not all" : "all"
          style.textContent =
            scenario === "style-text" ? ".secret {color:blue}" : ".secret {display:none}"
          document.head.append(style)
        }, kind)
      } else if (kind !== "insert")
        await link(
          "/hidden.css",
          kind === "rel-in"
            ? { rel: "preload", as: "style" }
            : kind === "media"
              ? { media: "not all" }
              : {},
        )
      const initiallyVisible = ["rel-in", "media", "style-media", "style-text", "insert"].includes(
        kind,
      )
      await expectContext(initiallyVisible)
      await page.evaluate((scenario) => {
        const node = document.querySelector("#test-css")
        if (scenario === "rel-out") node.rel = "icon"
        if (scenario === "rel-in") node.rel = "stylesheet"
        if (scenario === "media" || scenario === "style-media") node.media = "all"
        if (scenario === "disabled-idl") node.disabled = true
        if (scenario === "disabled-attribute") node.setAttribute("disabled", "")
        if (scenario === "style-text") node.textContent = ".secret {display:none}"
        if (scenario === "remove") node.remove()
      }, kind)
      if (kind === "insert") await link("/hidden.css")
      // This wait is on the actual CSS effect, not a manufactured mutation/timer.
      await page.waitForFunction(
        (want) => (getComputedStyle(document.querySelector(".secret")).display !== "none") === want,
        !initiallyVisible,
      )
      return await expectContext(!initiallyVisible)
    })
  await check("delayed @import completion", async () => {
    await reset()
    const id = String(++sequence)
    await page.evaluate((gateId) => {
      const style = document.createElement("style")
      style.dataset.stylesheetFixture = ""
      style.id = "test-css"
      style.textContent = `@import url('/hidden.css?delay=${gateId}');`
      document.head.append(style)
    }, id)
    await expectContext(true)
    const deadline = Date.now() + 10000
    while (!pendingCSS.has(id)) {
      if (Date.now() > deadline) throw new Error("Import gate not entered")
      await new Promise((done) => setTimeout(done, 10))
    }
    await page.evaluate(() => {
      window.styleFixtureLoaded = false
      document.querySelector("#test-css").addEventListener(
        "load",
        () => {
          window.styleFixtureLoaded = true
        },
        { once: true },
      )
    })
    pendingCSS.get(id)()
    pendingCSS.delete(id)
    await page.waitForFunction(() => window.styleFixtureLoaded)
    return await expectContext(false)
  })
  await check("stylesheet error rechecks current effective style", async () => {
    await reset()
    await link("/hidden.css")
    await expectContext(false)
    await page.evaluate(async () => {
      const css = document.querySelector("#test-css")
      const failed = new Promise((done) => css.addEventListener("error", done, { once: true }))
      css.href = "/missing.css"
      await failed
    })
    const visible = await page.evaluate(
      () => getComputedStyle(document.querySelector(".secret")).display !== "none",
    )
    const result = await expectContext(visible)
    return { ...result, effectiveVisibleAfterError: visible }
  })
  await check("alternate stylesheet activated by IDL state", async () => {
    await reset()
    await link("/hidden.css", { rel: "alternate stylesheet", title: "optional theme" })
    const visible = await page.evaluate(
      () => getComputedStyle(document.querySelector(".secret")).display !== "none",
    )
    await expectContext(visible)
    await page.evaluate(() => {
      const css = document.querySelector("#test-css")
      css.disabled = true
      css.disabled = false
    })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".secret")).display === "none",
    )
    return await expectContext(false)
  })
  await check("cross-origin opaque CSS still filters computed visibility", async () => {
    await reset()
    await expectContext(true)
    // localhost differs from the page's 127.0.0.1 origin; CSS remains readable
    // by style calculation but cssRules is intentionally inaccessible.
    await link(`http://localhost:${server.address().port}/hidden.css`)
    const opaque = await page.evaluate(() => {
      try {
        return !document.querySelector("#test-css").sheet.cssRules
      } catch (error) {
        return error.name === "SecurityError"
      }
    })
    if (!opaque) throw new Error("Expected opaque cross-origin cssRules")
    return { ...(await expectContext(false)), opaque }
  })
  await check("adopted sheet membership", async () => {
    await reset()
    await expectContext(true)
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(".secret {display:none}")
      document.adoptedStyleSheets = [sheet]
    })
    return await expectContext(false)
  })
  await check("same-count CSSOM edit fails closed before model dispatch", async () => {
    await reset()
    await link("/visible.css")
    await page.evaluate(() =>
      window.contextBrowser.translate(
        "CSSOM initial English request.",
        document.querySelector("#source"),
      ),
    )
    const before = models.length
    const result = await page.evaluate(async () => {
      document
        .querySelector("#test-css")
        .sheet.cssRules[0].style.setProperty("display", "none", "important")
      try {
        await window.contextBrowser.translate(
          "CSSOM pending English request.",
          document.querySelector("#source"),
        )
        return "unexpected-success"
      } catch (error) {
        return error.code
      }
    })
    if (result !== "CONTEXT_STALE" || models.length !== before)
      throw new Error(`Unsafe dispatch result=${result}, extraHTTP=${models.length - before}`)
    await page.evaluate(() =>
      window.contextBrowser.translate(
        "CSSOM explicit fresh English request.",
        document.querySelector("#source"),
      ),
    )
    if (JSON.stringify(models.at(-1)).replaceAll("\\", "").includes("PRIVATE_CONTEXT_SENTINEL"))
      throw new Error("Fresh context still contains hidden CSSOM source")
    return {
      refusedHTTP: 0,
      explicitFreshHTTP: 1,
      note: "No automatic retry. The next explicit operation receives fresh context.",
    }
  })
  await check("top-level insertRule and deleteRule are demand-observable", async () => {
    await reset()
    await link("/visible.css")
    await expectContext(true)
    await page.evaluate(() =>
      document.querySelector("#test-css").sheet.insertRule(".secret {display:none}", 0),
    )
    await expectContext(false)
    await page.evaluate(() => document.querySelector("#test-css").sheet.deleteRule(0))
    return await expectContext(true)
  })
  await check("viewport media query change is demand-observable", async () => {
    await reset()
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.evaluate(() => {
      const style = document.createElement("style")
      style.dataset.stylesheetFixture = ""
      style.textContent = "@media(max-width:700px){.secret {display:none}}"
      document.head.append(style)
    })
    await expectContext(true)
    await page.setViewportSize({ width: 600, height: 800 })
    await expectContext(false)
    await page.setViewportSize({ width: 1200, height: 800 })
    return await expectContext(true)
  })
  await check("shadow-local CSS preserves sibling snapshot", async () => {
    await reset()
    await page.evaluate(async () => {
      const api = window.contextBrowser
      const make = async (name) => {
        const host = document.createElement("div")
        document.body.append(host)
        const root = host.attachShadow({ mode: "open" })
        root.innerHTML =
          '<article><p>Safe source</p><aside class="secret">PRIVATE_CONTEXT_SENTINEL</aside></article>'
        const css = document.createElement("link")
        css.rel = "stylesheet"
        css.href = "/visible.css"
        const loaded = new Promise((done) => css.addEventListener("load", done, { once: true }))
        root.append(css)
        await loaded
        window[name] = root
      }
      await make("leftStyleRoot")
      await make("rightStyleRoot")
      window.leftSnapshot = await api.context.getOrCreateWebPageContext(true, undefined, {
        source: window.leftStyleRoot.querySelector("article"),
      })
      window.rightSnapshot = await api.context.getOrCreateWebPageContext(true, undefined, {
        source: window.rightStyleRoot.querySelector("article"),
      })
      const css = window.leftStyleRoot.querySelector("link")
      const loaded = new Promise((done) => css.addEventListener("load", done, { once: true }))
      css.href = "/hidden.css"
      await loaded
      const changed = await api.context.getOrCreateWebPageContext(true, undefined, {
        source: window.leftStyleRoot.querySelector("article"),
      })
      const unchanged = await api.context.getOrCreateWebPageContext(true, undefined, {
        source: window.rightStyleRoot.querySelector("article"),
      })
      if (changed.webContent.replaceAll("\\", "").includes("PRIVATE_CONTEXT_SENTINEL"))
        throw new Error("Shadow CSS privacy leak")
      if (unchanged !== window.rightSnapshot) throw new Error("Unrelated shadow snapshot rebuilt")
    })
    return await page.evaluate(() => window.contextBrowser.context.getContextDiagnostics())
  })
  await check(
    "six rendered translations survive global cosmetic stylesheet completion",
    async () => {
      await reset()
      await page.evaluate(async () => {
        const fixture = await window.contextBrowser.fixture("bilingual", 6, false)
        await fixture.task
      })
      const count = () =>
        page.evaluate(
          () => (document.querySelector("#a").textContent.match(/译文：/g) || []).length,
        )
      if ((await count()) !== 6) throw new Error("Initial six translations missing")
      const before = models.length
      await link("/visible.css")
      await page.evaluate(() =>
        window.contextBrowser.context.getOrCreateWebPageContext(true, undefined, {
          source: document.querySelector("#a"),
        }),
      )
      if ((await count()) !== 6) throw new Error("Global style cleared valid translations")
      if (models.length !== before) throw new Error("Cosmetic CSS sent a model request")
      return { rendered: 6, stylesheetModelHTTP: 0 }
    },
  )
  await page.evaluate(() => window.contextBrowser.cleanup())
  report.resources = await page.evaluate(() =>
    window.contextBrowser.context.getContextDiagnostics(),
  )
} finally {
  for (const done of pendingCSS.values()) done()
  await browser.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  report.modelHTTP = models.length
  report.cssHTTP = cssRequests
  report.sentContext = models.map((data) => ({
    name: data.name,
    containsPrivateContext: JSON.stringify(data)
      .replaceAll("\\", "")
      .includes("PRIVATE_CONTEXT_SENTINEL"),
  }))
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n")
}
console.log(
  JSON.stringify({
    passed: report.cases.filter((test) => test.status === "passed").length,
    failed: report.cases.filter((test) => test.status === "failed").length,
    modelHTTP: report.modelHTTP,
    cssHTTP: report.cssHTTP,
  }),
)
if (report.cases.some((test) => test.status === "failed")) process.exitCode = 1
