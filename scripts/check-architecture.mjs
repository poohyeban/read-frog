import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseSync } from "vite"

const baseline = "18f2c8cbfddc3df5e4b7552a48b1731c28ac4cfd"
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter((file) => existsSync(file))
const changed = new Set(
  execFileSync("git", ["diff", "--name-only", baseline], { encoding: "utf8" }).trim().split("\n"),
)
const production = files.filter(
  (f) => /^src\/.*\.[cm]?[jt]sx?$/.test(f) && !/(__tests__|\.test\.|\.d\.ts$)/.test(f),
)
const fileSet = new Set(files)
const graph = new Map()
const imports = new Map()
const dynamic = []
const issues = []

function runtimeImports(filename, source) {
  const result = parseSync(filename, source)
  if (result.errors.length) throw new Error(`Cannot parse ${filename}: ${result.errors[0].message}`)
  const specs = result.module.staticImports
    .filter((item) => item.entries.length === 0 || item.entries.some((entry) => !entry.isType))
    .map((item) => item.moduleRequest.value)
  for (const item of result.module.staticExports) {
    for (const entry of item.entries) {
      if (!entry.isType && entry.moduleRequest) specs.push(entry.moduleRequest.value)
    }
  }
  for (const item of result.module.dynamicImports) {
    const raw = source.slice(item.moduleRequest.start, item.moduleRequest.end)
    const literal = raw.match(/^(["'`])([^"'`$]+)\1$/)
    if (literal) specs.push(literal[2])
    else dynamic.push(filename)
  }
  return [...new Set(specs)]
}
// Type-only edges must never make a UI module a runtime dependency.
assert.deepEqual(
  runtimeImports(
    "fixture.ts",
    'import type { X } from "types"; import { type Y, z } from "runtime"; export type { A } from "types"; export * from "shared"; const p=import("lazy")',
  ),
  ["runtime", "shared", "lazy"],
)

function localFile(from, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return undefined
  const target = spec.startsWith("@/")
    ? `src/${spec.slice(2)}`
    : path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  return [
    target,
    ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"].map(
      (extension) => target + extension,
    ),
  ].find((candidate) => fileSet.has(candidate))
}
for (const file of production) {
  const specs = runtimeImports(file, await readFile(file, "utf8"))
  imports.set(file, specs)
  graph.set(file, specs.map((spec) => localFile(file, spec)).filter(Boolean))
}
const uiPackage =
  /^(?:react(?:-dom)?(?:\/|$)|jotai(?:-family)?(?:\/|$)|@tanstack\/react-|@(?:base-ui|iconify|tabler|remixicon)\/|motion(?:\/|$))/
const uiFile = /^src\/(?:components|hooks|utils\/atoms)\//
const pure =
  /^src\/utils\/(?:request\/|glossary\/(?:matcher|boundary|match-key|prompt|scope)\.ts$|subtitles\/(?:time-index|transcript)\.ts$|prompts\/(?:context|request-identity)\.ts$|host\/translate\/translate-text\.ts$)/
const background = /^src\/entrypoints\/background(?:\/|\.ts$)/
function checkReachable(root, forbidUI) {
  const pending = [[root, [root]]]
  const seen = new Set()
  while (pending.length) {
    const [file, chain] = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (forbidUI && uiFile.test(file)) issues.push(`UI boundary: ${chain.join(" -> ")}`)
    for (const spec of imports.get(file) ?? []) {
      if (forbidUI && uiPackage.test(spec))
        issues.push(`UI runtime: ${chain.join(" -> ")} -> ${spec}`)
    }
    for (const child of graph.get(file) ?? []) pending.push([child, [...chain, child]])
  }
}
for (const file of production.filter((f) => pure.test(f) || background.test(f)))
  checkReachable(file, true)
for (const [file, dependencies] of graph) {
  if (!background.test(file)) {
    for (const dependency of dependencies) {
      if (background.test(dependency))
        issues.push(
          `Background implementation imported outside background: ${file} -> ${dependency}`,
        )
    }
  }
}
// Browser-injected content scripts must stay self-contained; validate actual output when present.
if (process.argv.includes("--build")) {
  const manifest = JSON.parse(await readFile(".output/chrome-mv3/manifest.json", "utf8"))
  for (const script of manifest.content_scripts.flatMap((entry) => entry.js ?? [])) {
    const source = await readFile(path.join(".output/chrome-mv3", script), "utf8")
    if (
      runtimeImports(script, source).length ||
      parseSync(script, source).module.dynamicImports.length
    )
      issues.push(`Content script contains a runtime import: ${script}`)
  }
}
const uniqueIssues = [...new Set(issues)]
if (uniqueIssues.length) {
  console.error(uniqueIssues.slice(0, 25).join("\n"))
  console.error(`${uniqueIssues.length} architecture violations`)
  process.exitCode = 1
} else {
  console.log(
    `Architecture boundaries passed: ${production.length} production modules; ${[...graph.values()].reduce((sum, edges) => sum + edges.length, 0)} local runtime edges.`,
  )
}
if (process.argv.includes("--report")) {
  const pkg = JSON.parse(await readFile("package.json", "utf8"))
  const inventory = Object.fromEntries(
    Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
      .sort()
      .map((name) => [
        name,
        {
          classification: name in pkg.dependencies ? "runtime" : "development/build/test",
          sourceConsumers: [...imports]
            .filter(([, specs]) => specs.some((s) => s === name || s.startsWith(`${name}/`)))
            .map(([file]) => file),
        },
      ]),
  )
  await mkdir("docs/performance", { recursive: true })
  await writeFile(
    "docs/performance/audit-inventory.json",
    `${JSON.stringify(
      {
        baseline,
        scope:
          "Every tracked file inventoried; production TS/JS parsed with the installed Vite/Oxc parser. This is not a claim that every unchanged line was manually reviewed. CSS, config, tests and transitive dependency usage require the build/license audit as well.",
        productionModules: production.length,
        nonliteralDynamicImports: [...new Set(dynamic)],
        dependencies: inventory,
        files: files
          .filter((f) => !f.startsWith("docs/performance/"))
          .map((file) => ({
            file,
            review: changed.has(file)
              ? "changed: implementation/regression review"
              : graph.has(file)
                ? "runtime import graph reviewed; retained"
                : "inventory; retained",
            runtimeDependencies: graph.get(file),
          })),
      },
      null,
      2,
    )}\n`,
  )
}
