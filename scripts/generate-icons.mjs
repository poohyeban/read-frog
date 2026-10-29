// Tabler icons (MIT), bundled to keep Iconify entirely offline.
import fs from "node:fs"
import path from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
const tabler = await import("@tabler/icons-react")
// Keep persisted built-in Action names, using bundled MIT Tabler artwork.
const aliases = {
  "streamline-color:dictionary-language-book-flat": "book-2",
  "streamline-color:search-visual-flat": "language",
  "streamline-color:ai-edit-spark-flat": "pencil",
}
const names = new Set([
  "garden:translation-exists-stroke-16",
  "ri:translate",
  ...Object.keys(aliases),
])
function visit(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name)
    if (item.isDirectory()) visit(file)
    else if (/\.(ts|tsx)$/.test(file) && !file.endsWith("local-icons.ts")) {
      for (const match of fs
        .readFileSync(file, "utf8")
        .matchAll(/["']((?:tabler|ri|garden):[a-z0-9-]+)["']/g))
        names.add(match[1])
    }
  }
}
visit("src")
const icons = {}
for (const name of [...names].sort()) {
  const slug = aliases[name] ?? (name.startsWith("tabler:") ? name.split(":")[1] : "language")
  const symbol =
    "Icon" +
    slug
      .split("-")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("")
  if (!tabler[symbol]) throw new Error(`Missing local icon ${name} (${symbol})`)
  const svg = renderToStaticMarkup(React.createElement(tabler[symbol]))
  const body = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"))
  icons[name] = {
    width: 24,
    height: 24,
    body: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`,
  }
}
fs.writeFileSync(
  "src/utils/iconify/local-icons.ts",
  `// Generated from @tabler/icons-react (MIT); see LICENSES/tabler-icons.txt.\nimport { addIcon } from "@iconify/react/offline"\nconst icons = ${JSON.stringify(icons, null, 2)}\nexport function hasLocalIcon(name: string) { return Object.hasOwn(icons, name) }\nfor (const [name, icon] of Object.entries(icons)) addIcon(name, icon)\n`,
)
