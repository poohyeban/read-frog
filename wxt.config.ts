import process from "node:process"
import ViteYaml from "@modyfi/vite-plugin-yaml"
import { defineConfig } from "wxt"
export default defineConfig({
  srcDir: "src",
  imports: false,
  modules: ["@wxt-dev/module-react", "@wxt-dev/i18n/module"],
  manifestVersion: 3,
  manifest: {
    name: "Read Frog Lite",
    description: "Independent page, selection and subtitle translation with your own services.",
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
    ],
  },
  zip: {
    includeSources: ["**/*"],
    excludeSources: [".env*", "docs/**/*", "assets/**/*", "repos/**/*", "readmes/**/*"],
  },
  hooks: {
    "vite:build:extendConfig": (entrypoints, viteConfig) => {
      const entrypoint = entrypoints.length === 1 ? entrypoints[0] : undefined
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
