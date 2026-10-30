import { resolve, dirname } from "node:path"
import react from "@vitejs/plugin-react"
import { build } from "vite"

export async function buildHarness(sourceRoot, output) {
  const harness = resolve("e2e/translation-harness")
  const source = resolve(sourceRoot, "src")
  const replacements = new Map([
    [resolve(source, "utils/message"), `${harness}/messages.js`],
    [resolve(source, "utils/i18n"), `${harness}/i18n.js`],
    [resolve(source, "utils/i18n/locale-boundary"), `${harness}/i18n.js`],
  ])
  await build({
    configFile: false,
    root: sourceRoot,
    logLevel: "warn",
    resolve: { alias: { "@": source, "#imports": `${harness}/runtime.js` } },
    plugins: [
      react(),
      {
        name: "translation-browser-fixture",
        enforce: "pre",
        resolveId(id, importer) {
          if (id === "virtual:translation-entry") return "\0translation-entry"
          const absolute = id.startsWith("@/")
            ? resolve(source, id.slice(2))
            : id.startsWith(".") && importer
              ? resolve(dirname(importer), id)
              : id
          return replacements.get(absolute)
        },
        load(id) {
          if (id !== "\0translation-entry") return undefined
          return `
          import { PageTranslationManager } from '@/entrypoints/content-runtime/host/translation-control/page-translation'
          import { DEFAULT_CONFIG, CONFIG_STORAGE_KEY } from '@/utils/constants/config'
          import { storage } from '${harness}/runtime.js'
          import { metrics } from '${harness}/messages.js'
          import '@/assets/styles/translation-node-preset.css'
          const config = structuredClone(DEFAULT_CONFIG)
          config.providersConfig.find(p => p.id === config.pageTranslation.providerId).apiKey = 'local-fixture'
          config.language.sourceCode = 'eng'
          config.language.targetCode = 'cmn'
          config.pageTranslation.page.translateTitle = false
          config.pageTranslation.enableAIContentAware = new URLSearchParams(location.search).get('smart') === 'true'
          await storage.setItem('local:' + CONFIG_STORAGE_KEY, config)
          const manager = new PageTranslationManager()
          window.harness = { manager, metrics, config, async update() { await storage.setItem('local:' + CONFIG_STORAGE_KEY, config) } }
        `
        },
      },
    ],
    build: {
      target: "esnext",
      outDir: output,
      emptyOutDir: true,
      minify: true,
      rollupOptions: {
        input: "virtual:translation-entry",
        output: {
          entryFileNames: "entry.js",
          chunkFileNames: "[name].js",
          assetFileNames: "[name][extname]",
        },
      },
    },
  })
}
