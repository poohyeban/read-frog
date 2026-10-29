import process from "node:process"
import ViteYaml from "@modyfi/vite-plugin-yaml"
import { defineConfig } from "wxt"
const CONTENT_RUNTIME_NAME = "content-runtime"
export default defineConfig({
  srcDir: "src",
  imports: false,
  modules: ["@wxt-dev/module-react", "@wxt-dev/i18n/module"],
  manifestVersion: 3,
  manifest: {
    name: "Read Frog Lite",
    description: "Private page and selection translation with your own API.",
    default_locale: "en",
    permissions: [
      "offscreen",
      "storage",
      "tabs",
      "alarms",
      "contextMenus",
      "scripting",
      "webNavigation",
    ],
    host_permissions: ["*://*/*"],
    web_accessible_resources: [
      {
        resources: ["assets/*.png", "assets/*.svg", "assets/*.webp"],
        matches: ["*://*/*", "file:///*"],
      },
      {
        resources: [CONTENT_RUNTIME_NAME + ".js"],
        matches: ["*://*/*", "file:///*"],
        use_dynamic_url: true,
      },
      { resources: [CONTENT_RUNTIME_NAME + "/*"], matches: ["*://*/*", "file:///*"] },
    ],
  },
  zip: {
    includeSources: ["**/*"],
    excludeSources: [".env*", "docs/**/*", "assets/**/*", "repos/**/*", "readmes/**/*"],
  },
  hooks: {
    "vite:build:extendConfig": (entrypoints, viteConfig) => {
      const entrypoint = entrypoints.length === 1 ? entrypoints[0] : undefined
      if (entrypoint?.type === "unlisted-script" && entrypoint.name === CONTENT_RUNTIME_NAME) {
        // WXT builds every script as one IIFE. The content runtime is imported
        // as an ES module instead, so it can leave code (such as the locales
        // it doesn't use) in chunks that load when needed.
        if (viteConfig.build?.lib) viteConfig.build.lib.formats = ["es"]
        const output = viteConfig.build?.rollupOptions?.output
        for (const outputOptions of Array.isArray(output) ? output : output ? [output] : []) {
          outputOptions.chunkFileNames = `${CONTENT_RUNTIME_NAME}/[name]-[hash].js`
          outputOptions.assetFileNames = "assets/[name]-[hash].[ext]"
          // Vite keeps whitespace and pure annotations in ES library output for
          // the bundlers that would consume it; nothing bundles this one again.
          if (viteConfig.build?.minify !== false) {
            outputOptions.minify = true
            outputOptions.comments = false
          }
        }
        return
      }
      if (entrypoint?.type !== "content-script") return

      const output = viteConfig.build?.rollupOptions?.output
      if (!output) return

      for (const outputOptions of Array.isArray(output) ? output : [output]) {
        outputOptions.assetFileNames = (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".css"))
            ? `content-scripts/${entrypoint.name}.[ext]`
            : "assets/[name]-[hash].[ext]"
      }
    },
  },
  dev: { server: { port: 3333, strictPort: false } },
  vite: () => ({
    resolve: {
      dedupe: [
        "@codemirror/state",
        "@codemirror/view",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/autocomplete",
        "@codemirror/search",
        "@codemirror/commands",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
      ],
    },
    plugins: [
      ViteYaml(),
      {
        name: "check-api-key-env",
        buildStart() {
          const keys = Object.keys(process.env).filter((key) => /^WXT_.*API_KEY/.test(key))
          if (keys.length)
            throw new Error("API keys must be configured locally, not bundled: " + keys.join(", "))
        },
      },
    ],
  }),
})
