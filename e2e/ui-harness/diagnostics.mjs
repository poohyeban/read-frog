import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
export function uiDiagnostics(output, profile = true) {
  return {
    name: "ui-build-diagnostics",
    enforce: "pre",
    transform(code, id) {
      if (!profile) return undefined
      if (id.endsWith("/entrypoints/popup/main.tsx"))
        return `${code}\nwindow.__uiModuleReady = performance.now()`
      if (id.endsWith("/utils/react-root.ts"))
        return `import { Profiler as AuditProfiler, createElement as auditElement } from 'react'\n${code.replaceAll("root.render(app)", `root.render(auditElement(AuditProfiler, { id: 'Root', onRender: (...args) => { (globalThis.__uiProfiles ??= []).push(args) } }, app))`).replaceAll("existingRoot.render(app)", `existingRoot.render(auditElement(AuditProfiler, { id: 'Root', onRender: (...args) => { (globalThis.__uiProfiles ??= []).push(args) } }, app))`)}`
      if (id.endsWith("/entrypoints/popup/app.tsx")) {
        const tags = [
          "LanguageOptionsSelector",
          "ProvidersField",
          "TranslatePromptSelector",
          "TranslateButton",
          "SiteControlToggle",
          "AlwaysTranslate",
          "Hotkey",
          "AISmartContext",
        ]
        for (const tag of tags)
          code = code.replace(
            new RegExp(`<${tag}(\\s[^>]*?)?\\s*/>`, "g"),
            (match) =>
              `<AuditProfiler id="${tag}" onRender={(...args) => { (globalThis.__uiProfiles ??= []).push(args) }}>${match}</AuditProfiler>`,
          )
        return `import { Profiler as AuditProfiler } from 'react'\n${code}`
      }
      const phase = id.endsWith("/utils/config/storage.ts")
        ? "config"
        : id.endsWith("/utils/i18n/index.ts")
          ? "i18n"
          : undefined
      const fn = phase === "config" ? "getLocalConfig" : "initI18n"
      if (phase) {
        code = code.replace(`export async function ${fn}(`, `async function original_${fn}(`)
        code += `\nexport async function ${fn}(...args: Parameters<typeof original_${fn}>) { const start=performance.now();try { return await original_${fn}(...args) } finally { (globalThis.__uiPhases ??= []).push({phase:'${phase}',start,end:performance.now()}) } }`
        if (phase === "config")
          code = code.replace(
            "const parsed = configSchema.safeParse(config)",
            `const parseStart=performance.now(); const parsed = configSchema.safeParse(config); (globalThis.__uiPhases ??= []).push({phase:'config-zod',start:parseStart,end:performance.now()})`,
          )
        return code
      }
      return undefined
    },
    generateBundle(_options, bundle) {
      mkdirSync(output, { recursive: true })
      const chunks = Object.values(bundle)
        .filter((item) => item.type === "chunk")
        .map((chunk) => ({
          file: chunk.fileName,
          bytes: Buffer.byteLength(chunk.code),
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          modules: Object.entries(chunk.modules)
            .map(([file, module]) => ({ file, renderedLength: module.renderedLength }))
            .sort((a, b) => b.renderedLength - a.renderedLength),
        }))
      if (chunks.length)
        writeFileSync(
          resolve(
            output,
            `graph-${chunks.find((c) => c.file.includes("popup")) ? "html" : chunks[0].file.replaceAll("/", "_")}.json`,
          ),
          JSON.stringify(chunks, null, 2),
        )
    },
  }
}
