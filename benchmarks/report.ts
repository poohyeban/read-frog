import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { cpus, platform, arch } from "node:os"
import { resolve } from "node:path"

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
// Capture before running: long soaks must not be attributed to a later commit.
// Only digests are retained, never configuration values or diff contents.
const diff = execFileSync("git", ["diff", "--no-ext-diff", "HEAD", "--binary"])
const environment = {
  source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  trackedChanges: diff.length > 0,
  trackedDiffSHA256: hash(diff),
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  lockSHA256: hash(readFileSync("pnpm-lock.yaml")),
  startedAt: new Date().toISOString(),
}
export const outputDirectory = resolve(process.env.PERF_OUTPUT ?? "scripts/output/performance")
export async function report(name: string, data: unknown) {
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(
    resolve(outputDirectory, `${name}.json`),
    `${JSON.stringify(
      {
        ...environment,
        timestamp: new Date().toISOString(),
        data,
      },
      null,
      2,
    )}\n`,
  )
}
export function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  }
}
