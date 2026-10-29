import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve as resolvePath } from "node:path"
import { chromium, expect, test } from "@playwright/test"

// Investigation only: launch the unchanged, checksum-verified published ZIP.
// The optional observer records send arguments but forwards the original callback
// untouched, so it does not consume lastError or hide the original browser warning.
test("diagnose missing message receivers in the published 0.2.2 extension", async () => {
  const report = { version: "0.2.2", cases: [], console: [], externalRequests: [] }
  const output = resolvePath(".diagnostics/artifacts")
  await mkdir(output, { recursive: true })
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html")
    response.end(
      "<!doctype html><html lang='en'><head><title>Receiver diagnostic fixture</title></head><body><p>This ordinary page contains enough English words for the translation extension to detect its language.</p></body></html>",
    )
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let context
  try {
    const extensionPath = resolvePath(".diagnostics/extension")
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: false,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    await context.tracing.start({ screenshots: true, snapshots: true })
    context.on("console", (message) =>
      report.console.push({ type: message.type(), text: message.text() }),
    )
    context.on("request", (request) => {
      const url = new URL(request.url())
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin)
        report.externalRequests.push(`${url.origin}${url.pathname}`)
    })
    let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
    const extensionId = new URL(worker.url()).host
    report.extensionId = extensionId
    await expect
      .poll(() =>
        worker.evaluate(async () =>
          Boolean((await chrome.storage.local.get("readFrogLiteConfig")).readFrogLiteConfig),
        ),
      )
      .toBe(true)
    const manager = await context.newPage()
    await manager.goto("chrome://extensions/")
    await manager.evaluate(
      () =>
        new Promise((resolve, reject) => {
          chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => {
            const error = chrome.runtime.lastError?.message
            if (error) reject(new Error(error))
            else resolve()
          })
        }),
    )
    const errors = async () => {
      return manager.evaluate(
        (id) =>
          new Promise((resolve, reject) => {
            chrome.developerPrivate.getExtensionInfo(id, (info) => {
              const error = chrome.runtime.lastError?.message
              if (error) reject(new Error(error))
              else resolve(info.runtimeErrors)
            })
          }),
        extensionId,
      )
    }
    const clearErrors = async () => {
      await manager.evaluate(
        (id) =>
          new Promise((resolve, reject) => {
            chrome.developerPrivate.deleteExtensionErrors({ extensionId: id }, () => {
              const error = chrome.runtime.lastError?.message
              if (error) reject(new Error(error))
              else resolve()
            })
          }),
        extensionId,
      )
    }
    const first = await context.newPage()
    const second = await context.newPage()
    await first.goto(`${origin}/first`)
    await second.goto(`${origin}/second`)
    for (const page of [first, second])
      await expect(page.locator("read-frog-lite button").first()).toBeAttached()
    const tabs = await worker.evaluate(() => chrome.tabs.query({}))
    report.tabs = tabs.map(({ id, url }) => ({ id, url }))
    const managerId = tabs.find((tab) => tab.url === "chrome://extensions/")?.id
    expect(managerId).toBeDefined()
    let observing = false
    const activate = async (label, page) => {
      await clearErrors()
      if (observing)
        await worker.evaluate(() => {
          globalThis.__receiverTrace.length = 0
        })
      await page.bringToFront()
      // Allow asynchronous tab activation/language detection to finish, without
      // introducing any requests to an AI provider.
      await page.waitForTimeout(800)
      const result = { label, url: page.url(), errors: await errors() }
      if (observing) result.messages = await worker.evaluate(() => globalThis.__receiverTrace)
      report.cases.push(result)
      console.log("RECEIVER_CASE", JSON.stringify(result))
      return result
    }
    await first.bringToFront()
    await first.waitForTimeout(500)
    await activate("baseline: ordinary page to ordinary page", second)
    for (let round = 1; round <= 3; round++) {
      await activate(`baseline: internal page ${round}`, manager)
      await activate(`baseline: healthy page ${round}`, first)
    }
    await worker.evaluate(() => {
      globalThis.__receiverTrace = []
      const original = chrome.tabs.sendMessage
      chrome.tabs.sendMessage = function (...args) {
        const [tabId, message, options] = args
        globalThis.__receiverTrace.push({
          tabId,
          type: message?.type,
          frameId: options?.frameId ?? null,
          stack: new Error("sendMessage diagnostic").stack,
        })
        return original.apply(this, args)
      }
    })
    observing = true
    const tracedInternal = await activate("observed: internal page", manager)
    await manager.goto(`chrome://extensions/?errors=${extensionId}`)
    await manager.screenshot({ path: `${output}/internal-page-error.png`, fullPage: true })
    await activate("observed: healthy page", second)
    const blank = await context.newPage()
    await second.bringToFront()
    await activate("observed: about blank", blank)
    await activate("observed: healthy page after blank", first)

    // Reload only the test profile's extension, then compare a stale page with
    // the same page after navigation has injected the new content script.
    observing = false
    await clearErrors()
    const replacement = context.waitForEvent("serviceworker", {
      predicate: (next) => next !== worker,
    })
    await worker.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 0)
    })
    worker = await replacement
    await expect
      .poll(() =>
        worker.evaluate(async () =>
          Boolean((await chrome.storage.local.get("readFrogLiteConfig")).readFrogLiteConfig),
        ),
      )
      .toBe(true)
    await second.reload()
    await expect(second.locator("read-frog-lite button").first()).toBeAttached()
    await second.bringToFront()
    await second.waitForTimeout(500)
    await activate("after extension reload: stale ordinary page", first)
    await first.reload()
    await expect(first.locator("read-frog-lite button").first()).toBeAttached()
    await second.bringToFront()
    await second.waitForTimeout(500)
    await activate("after extension reload: refreshed ordinary page", first)
    await activate("after extension reload: internal page", manager)

    const missingReceiver = (entry) => entry.message.includes("Receiving end does not exist")
    for (const result of report.cases.filter((entry) =>
      entry.label.startsWith("baseline: internal"),
    ))
      expect(result.errors.some(missingReceiver)).toBe(true)
    for (const result of report.cases.filter(
      (entry) =>
        entry.label.startsWith("baseline: healthy") ||
        entry.label.includes("ordinary page to ordinary page"),
    ))
      expect(result.errors.filter(missingReceiver)).toEqual([])
    expect(
      tracedInternal.messages.some(
        (message) => message.type === "refreshDetectedPageLanguage" && message.tabId === managerId,
      ),
    ).toBe(true)
    expect(tracedInternal.errors.some(missingReceiver)).toBe(true)
    expect(report.externalRequests).toEqual([])
  } finally {
    await writeFile(`${output}/diagnosis.json`, JSON.stringify(report, null, 2))
    await context?.tracing.stop({ path: `${output}/trace.zip` })
    await context?.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
