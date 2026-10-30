import { spawnSync } from "node:child_process"
// Separate production profiling build; never compare its timings with normal builds.
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
const profile = process.env.UI_PROFILE !== "0"
const source = resolve(process.argv[2] || ".")
const output = resolve(process.argv[3] || "/tmp/ui-diagnostics")
await mkdir(output, { recursive: true })
const config = resolve(source, "ui-diagnostics.config.ts")
const plugin = resolve("e2e/ui-harness/diagnostics.mjs")
const base = resolve(source, "wxt.config.ts")
// This temporary config is removed by the caller after the diagnostic build.
await writeFile(
  config,
  `import base from ${JSON.stringify(base)}\nimport { uiDiagnostics } from ${JSON.stringify(plugin)}\nexport default { ...base, outDir: ${JSON.stringify(output)}, vite: (...args) => { const vite = base.vite(...args); return { ...vite, resolve: { ...vite.resolve, alias: ${profile ? "{ 'react-dom/client': 'react-dom/profiling' }" : "{}"} }, plugins: [uiDiagnostics(${JSON.stringify(output)}, ${profile}), ...vite.plugins] } } }\n`,
)
const result = spawnSync(resolve("node_modules/.bin/wxt"), ["build", "--config", config], {
  cwd: source,
  stdio: "inherit",
  env: process.env,
})
const { unlink } = await import("node:fs/promises")
await unlink(config)
if (result.status !== 0) process.exit(result.status ?? 1)
await readFile(resolve(output, "chrome-mv3/popup.html"))
