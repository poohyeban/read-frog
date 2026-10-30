import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import yaml from "@modyfi/vite-plugin-yaml"
import { build } from "vite"
const out = resolve(process.argv[2] || "/tmp/read-frog-ui-fixture")
await mkdir(out, { recursive: true })
await build({
  configFile: false,
  logLevel: "warn",
  resolve: {
    alias: { "@": resolve("src"), "#imports": resolve("e2e/translation-harness/runtime.js") },
  },
  plugins: [
    yaml(),
    {
      name: "ui-config-fixture",
      resolveId(id) {
        if (id === "virtual:fixture") return "\0fixture"
      },
      load(id) {
        if (id === "\0fixture")
          return `export { DEFAULT_CONFIG as default } from '@/utils/constants/config'`
      },
    },
  ],
  build: {
    outDir: out,
    emptyOutDir: true,
    rolldownOptions: {
      input: "virtual:fixture",
      preserveEntrySignatures: "strict",
      output: { entryFileNames: "fixture.mjs", codeSplitting: false },
    },
  },
})
const { default: config } = await import(`${out}/fixture.mjs`)
await writeFile(`${out}/config.json`, JSON.stringify(config))
