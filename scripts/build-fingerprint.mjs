import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
const digest = (data) => createHash("sha256").update(data).digest("hex")
const output = ".output/chrome-mv3"
async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(filename)))
    else {
      const data = await readFile(filename)
      files.push({
        path: path.relative(output, filename),
        bytes: data.length,
        sha256: digest(data),
      })
    }
  }
  return files
}
const files = await collect(output)
const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"))
const result = {
  source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  node: process.version,
  packageManager: JSON.parse(await readFile("package.json", "utf8")).packageManager,
  lockSHA256: digest(await readFile("pnpm-lock.yaml")),
  configSHA256: digest(await readFile("wxt.config.ts")),
  manifest,
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  files,
}
await mkdir("scripts/output/performance", { recursive: true })
await writeFile("scripts/output/performance/build.json", `${JSON.stringify(result, null, 2)}\n`)
console.log(
  `Manifest ${manifest.version}; ${files.length} files; ${result.totalBytes} bytes. Fingerprints recorded.`,
)
