import { readFile, writeFile } from "node:fs/promises"
const files = { before: process.argv[2], after: process.argv[3] }
const output = process.argv[4] || "docs/ui-performance/module-graph.json"
const normalize = (id) =>
  id.includes("/node_modules/")
    ? "node_modules/" + id.split("/node_modules/").at(-1)
    : id.includes("/src/")
      ? "src/" + id.split("/src/").at(-1)
      : id
const category = (id) => {
  if (id.includes("/locales/") && id.endsWith(".yml")) return "locale resources"
  if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "React runtime"
  if (id.includes("@base-ui/")) return "Base UI"
  if (/node_modules\/(motion|motion-dom|motion-utils|framer-motion)\//.test(id)) return "Motion"
  if (/node_modules\/(ai|ai-sdk-ollama|@ai-sdk)\//.test(id)) return "model SDKs"
  if (/node_modules\/(@codemirror|@lezer|@uiw)\//.test(id)) return "CodeMirror"
  if (id.includes("zod/")) return "Zod"
  if (/(@iconify|@tabler|@remixicon|iconify\/local-icons)/.test(id)) return "icons"
  if (id.includes("@tanstack/")) return "TanStack"
  if (/node_modules\/(jotai|jotai-family)\//.test(id)) return "Jotai"
  if (id.startsWith("src/")) return "application"
  return "other dependencies"
}
const versions = {}
for (const [version, path] of Object.entries(files)) {
  const chunks = JSON.parse(await readFile(path, "utf8")).map((chunk) => ({
    ...chunk,
    modules: chunk.modules.map((module) => ({ ...module, file: normalize(module.file) })),
  }))
  const map = new Map(chunks.map((chunk) => [chunk.file, chunk]))
  const entries = {}
  for (const entry of ["popup", "options", "translation-hub"]) {
    const first = chunks.find((chunk) => new RegExp(`chunks/${entry}-`).test(chunk.file))
    const seen = new Set()
    const visit = (file) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const child of map.get(file)?.imports || []) visit(child)
    }
    visit(first.file)
    const groups = {}
    const modules = []
    for (const file of seen)
      for (const module of map.get(file)?.modules || []) {
        const key = category(module.file)
        groups[key] = (groups[key] || 0) + (module.renderedLength || 0)
        modules.push(module)
      }
    entries[entry] = {
      entry: first.file,
      staticChunks: [...seen],
      bytes: [...seen].reduce((n, file) => n + (map.get(file)?.bytes || 0), 0),
      groups,
      largestModules: modules
        .sort((a, b) => (b.renderedLength || 0) - (a.renderedLength || 0))
        .slice(0, 20),
    }
  }
  versions[version] = { entries, chunks }
}
await writeFile(
  output,
  JSON.stringify(
    {
      note: "Normal production builds, no profiling aliases or runtime instrumentation. Chunk bytes are minified JS bytes. Module renderedLength is the bundler attribution before final minification and cannot be summed against minified file sizes. Only static transitive imports are included per entry; actual route resources are measured separately.",
      versions,
    },
    null,
    2,
  ),
)
console.log(
  Object.fromEntries(
    Object.entries(versions).map(([v, data]) => [
      v,
      Object.fromEntries(
        Object.entries(data.entries).map(([entry, entryData]) => [
          entry,
          { bytes: entryData.bytes, groups: entryData.groups },
        ]),
      ),
    ]),
  ),
)
