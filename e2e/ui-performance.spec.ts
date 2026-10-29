import type { Config } from "../src/types/config/config"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium, expect, test } from "@playwright/test"

test("records production UI navigation observations", async () => {
  test.skip(process.env.PERF_BROWSER !== "true", "Opt-in observations; no duration gate")
  test.setTimeout(180_000)
  const extensionPath = resolve(process.env.PERF_EXTENSION_PATH ?? ".output/chrome-mv3")
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    headless: !process.env.CI,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  })
  try {
    await context.route(/^https?:/, (route) => route.abort())
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 15_000 }))
    const extensionId = new URL(worker.url()).host
    type API = {
      storage: {
        local: {
          get: (key: string) => Promise<Record<string, Config>>
          set: (value: Record<string, Config>) => Promise<void>
        }
      }
    }
    await expect
      .poll(() =>
        worker.evaluate(async () =>
          Boolean(
            (
              await (globalThis as unknown as { chrome: API }).chrome.storage.local.get(
                "readFrogLiteConfig",
              )
            ).readFrogLiteConfig,
          ),
        ),
      )
      .toBe(true)
    await worker.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: API }).chrome
      const config = (await api.storage.local.get("readFrogLiteConfig")).readFrogLiteConfig!
      config.uiLanguage = "en"
      await api.storage.local.set({ readFrogLiteConfig: config })
    })
    const samples: Record<string, number[]> = {}
    const firstNavigations: Record<string, number> = {}
    for (const surface of ["popup", "options", "translation-hub"] as const) {
      const page = await context.newPage()
      const target = `chrome-extension://${extensionId}/${surface}.html${surface === "options" ? "#/api-providers" : ""}`
      for (let run = -3; run < 30; run++) {
        await page.goto("about:blank")
        const started = performance.now()
        await page.goto(target)
        if (surface === "popup")
          await expect(page.getByLabel("Source", { exact: true })).toBeVisible()
        else if (surface === "options")
          await expect(
            page.getByRole("button", { name: "Add provider", exact: true }),
          ).toBeVisible()
        else await expect(page.getByPlaceholder("Enter text to translate...")).toBeVisible()
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        )
        const elapsed = performance.now() - started
        if (run === -3) firstNavigations[surface] = elapsed
        if (run >= 0) (samples[surface] ??= []).push(elapsed)
      }
      await page.close()
    }
    const quantiles = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return {
        p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      }
    }
    const manifest = JSON.parse(
      await readFile(resolve(extensionPath, "manifest.json"), "utf8"),
    ) as { version: string }
    await mkdir("scripts/output/performance", { recursive: true })
    await writeFile(
      `scripts/output/performance/browser-ui-${process.env.PERF_LABEL ?? "current"}.json`,
      JSON.stringify(
        {
          version: manifest.version,
          browser: context.browser()?.version(),
          node: process.version,
          caveat:
            "Production navigation to ready controls plus two frames; includes automation overhead. Three warmups then 30 navigations, one fresh profile. First-navigation samples are not independent cold-extension launches. No HTTP/model latency or React profiling durations.",
          firstNavigations,
          samples,
          milliseconds: Object.fromEntries(
            Object.entries(samples).map(([name, values]) => [name, quantiles(values)]),
          ),
        },
        null,
        2,
      ),
    )
  } finally {
    await context.close()
  }
})
