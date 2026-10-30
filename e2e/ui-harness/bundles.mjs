import { readFile, writeFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { gzipSync } from "node:zlib"
const root = resolve(process.argv[2] || ".output/chrome-mv3")
const output = process.argv[3] || "docs/ui-performance/bundles.json"
const entries = {}
for (const name of ["popup", "options", "translation-hub"]) {
  const html = await readFile(resolve(root, `${name}.html`), "utf8")
  const seeds = [...html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map((m) =>
    resolve(root, m[1].replace(/^\//, "")),
  )
  const seen = new Set()
  const assets = []
  async function visit(file) {
    if (seen.has(file)) return
    seen.add(file)
    const bytes = await readFile(file)
    assets.push({
      file: file.slice(root.length + 1),
      bytes: bytes.length,
      gzip: gzipSync(bytes).length,
    })
    if (file.endsWith(".js")) {
      const text = bytes.toString()
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+\.js)["']/g))
        await visit(resolve(dirname(file), m[1]))
    }
  }
  for (const seed of seeds) await visit(seed)
  entries[name] = {
    js: assets.filter((a) => a.file.endsWith(".js")).reduce((n, a) => n + a.bytes, 0),
    css: assets.filter((a) => a.file.endsWith(".css")).reduce((n, a) => n + a.bytes, 0),
    gzip: assets.reduce((n, a) => n + a.gzip, 0),
    assets: assets.sort((a, b) => b.bytes - a.bytes),
  }
}
await writeFile(
  output,
  JSON.stringify(
    {
      root,
      method:
        "Transitive static import/export graph plus HTML modulepreload/CSS; gzip informational, extension resources are local",
      entries,
    },
    null,
    2,
  ),
)
console.log(
  Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [
      k,
      { js: v.js, css: v.css, gzip: v.gzip, largest: v.assets.slice(0, 5) },
    ]),
  ),
)
