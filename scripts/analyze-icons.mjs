import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { gzipSync } from "node:zlib"
import * as tabler from "@tabler/icons-react"
import { build } from "vite"

const source = await readFile("src/utils/iconify/local-icons.ts", "utf8")
const names = [...source.matchAll(/^  "([^"]+)": \{/gm)].map((match) => match[1])
const aliases = {
  "garden:translation-exists-stroke-16": "IconLanguage",
  "ri:translate": "IconLanguage",
  "streamline-color:ai-edit-spark-flat": "IconPencil",
  "streamline-color:dictionary-language-book-flat": "IconBook2",
  "streamline-color:search-visual-flat": "IconLanguage",
}
const mappings = names.map((name) => [
  name,
  aliases[name] ??
    `Icon${name
      .replace(/^tabler:/, "")
      .split("-")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("")}`,
])
const missing = mappings.filter(([, name]) => !(name in tabler))
const prototype = `import {createElement} from 'react'; import {${[...new Set(mappings.filter(([, name]) => name in tabler).map(([, name]) => name))].join(",")}} from '@tabler/icons-react'; const icons = {${mappings
  .filter(([, name]) => name in tabler)
  .map(([key, name]) => `${JSON.stringify(key)}:${name}`)
  .join(
    ",",
  )}}; export const Icon = ({icon,...props})=>icons[icon] ? createElement(icons[icon],props) : null;`
async function measure(name, code) {
  await mkdir("scripts/output/icon-analysis", { recursive: true })
  const entry = path.resolve(
    "scripts/output/icon-analysis",
    name.includes("prototype") ? "candidate.js" : "current.js",
  )
  await writeFile(entry, code)
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: true,
      lib: { entry, formats: ["es"] },
      rolldownOptions: { external: ["react", "react/jsx-runtime"] },
    },
  })
  const output = (Array.isArray(result) ? result : [result])
    .flatMap((item) => item.output)
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n")
  return { name, bytes: Buffer.byteLength(output), gzipBytes: gzipSync(output).length }
}
const current = await measure(
  "offline registry + Iconify renderer",
  `import ${JSON.stringify(path.resolve("src/utils/iconify/local-icons.ts"))}; export {Icon} from '@iconify/react/offline';`,
)
const candidate = await measure("Tabler name-map prototype", prototype)
await mkdir("scripts/output/performance", { recursive: true })
const report = {
  names: names.length,
  missing,
  current,
  candidate,
  caveat:
    "Isolated production-minified icon entry, React external. Prototype covers names, not full Iconify prop/ref/flip/accessibility or brand-resource compatibility; not a production application bundle or initialization benchmark.",
  decision:
    "Retain current offline renderer and persisted names. Prefer static Tabler imports for new UI. A whole-app migration requires production browser visual/accessibility/initialization evidence that is unavailable in this managed environment.",
}
await writeFile("scripts/output/performance/icons.json", `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
