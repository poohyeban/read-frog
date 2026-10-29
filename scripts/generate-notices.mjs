// Usage: pnpm licenses list --prod --json | node scripts/generate-notices.mjs
import fs from "node:fs"
import path from "node:path"
let input = ""
for await (const chunk of process.stdin) input += chunk
const groups = JSON.parse(input)
const packages = Object.values(groups).flat()
// Iconify is build-time listed but its offline renderer ships in the extension.
for (const name of ["@iconify/react", "@iconify/types", "@iconify/utils"]) {
  const entry = path.resolve("node_modules", name)
  let location
  try {
    location = fs.realpathSync(entry)
  } catch {
    continue
  }
  const meta = JSON.parse(fs.readFileSync(path.join(location, "package.json"), "utf8"))
  packages.push({ name, versions: [meta.version], paths: [location], license: meta.license })
}
const sections = [],
  missing = []
for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
  const files = [
    ...new Set(
      pkg.paths.flatMap((dir) =>
        fs
          .readdirSync(dir)
          .filter((name) => /^(licen[cs]e|copying|notice|ofl)(\.|$|-)/i.test(name))
          .filter((name) => fs.statSync(path.join(dir, name)).isFile())
          .map((name) => path.join(dir, name)),
      ),
    ),
  ]
  const texts = [...new Set(files.map((file) => fs.readFileSync(file, "utf8")))]
  if (!texts.length) missing.push(pkg.name)
  sections.push(
    `${pkg.name} ${pkg.versions.join(", ")} (${pkg.license})\n${pkg.homepage ?? ""}\n${texts.join("\n")}`,
  )
}
fs.copyFileSync("LICENSE", "public/LICENSE")
fs.copyFileSync("LICENSES/iso-639-3.txt", "public/ISO-639-LICENSE.txt")
fs.copyFileSync("LICENSES/Apache-2.0.txt", "public/APACHE-2.0-LICENSE.txt")
fs.writeFileSync(
  "public/THIRD-PARTY-NOTICES.txt",
  "Dependency license notices; includes production dependency metadata and bundled offline icons.\n\n" +
    sections.join("\n\n" + "=".repeat(72) + "\n\n"),
)
if (missing.length)
  process.stderr.write(
    "Packages without root license text (metadata retained): " + missing.join(", ") + "\n",
  )
