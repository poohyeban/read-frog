// Read-only policy check and unpacked MV3 availability probe. No policy changes.
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { chromium } from "@playwright/test"

const output = resolve(process.argv[2] || "test-results/mv3-preflight.json")
const extension = resolve(process.env.SUBTITLE_EXTENSION_PATH || ".output/chrome-mv3")
const evidence = { checkedAt: new Date().toISOString(), status: "unavailable", policies: [] }
let context
try {
  for (const directory of ["/etc/chromium/policies/managed", "/etc/opt/chrome/policies/managed"]) {
    for (const file of await readdir(directory).catch(() => [])) {
      if (!file.endsWith(".json")) continue
      const policy = JSON.parse(await readFile(`${directory}/${file}`, "utf8"))
      if (policy.ExtensionInstallBlocklist || policy.ExtensionSettings) {
        evidence.policies.push({
          file: `${directory}/${file}`,
          blocklist: policy.ExtensionInstallBlocklist,
          defaultInstallationMode: policy.ExtensionSettings?.["*"]?.installation_mode,
        })
      }
    }
  }
  if (
    evidence.policies.some(
      (p) => p.blocklist?.includes("*") || p.defaultInstallationMode === "blocked",
    )
  ) {
    evidence.status = "blocked-by-policy"
    evidence.reason =
      "Unpacked extension probe not attempted: managed extension installation is blocked."
    process.exitCode = 2
  } else {
    const manifest = JSON.parse(await readFile(`${extension}/manifest.json`, "utf8"))
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      headless: process.env.MV3_HEADED !== "1",
      args: [`--load-extension=${extension}`],
    })
    evidence.browser = context.browser().version()
    const matches = async (worker) => {
      try {
        const actual = await worker.evaluate(() => chrome.runtime.getManifest())
        return (
          actual.name === manifest.name &&
          actual.version === manifest.version &&
          actual.manifest_version === 3
        )
      } catch {
        return false
      }
    }
    let worker
    for (const candidate of context.serviceWorkers())
      if (await matches(candidate)) worker = candidate
    worker ??= await context.waitForEvent("serviceworker", { predicate: matches, timeout: 15_000 })
    evidence.worker = worker.url()
    evidence.status = "available-not-accepted"
    evidence.reason =
      "Native MV3 loaded; platform, lifecycle and manual acceptance cases still need to run."
  }
} catch (error) {
  evidence.reason = error.message
  process.exitCode = 2
} finally {
  await context?.close()
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
}
