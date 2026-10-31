import type { Config } from "@/types/config/config"
import { useMutation } from "@tanstack/react-query"
import { kebabCase } from "case-anything"
import { saveAs } from "file-saver"
import { storage } from "#imports"
import { toastManager } from "@/components/ui/base-ui/toast"
import { getObjectWithoutAPIKeys } from "@/utils/config/api"
import { APP_NAME } from "@/utils/constants/app"
import { i18n } from "@/utils/i18n"
import {
  PERFORMANCE_STORAGE_KEY,
  performanceOverridesSchema,
  portablePerformanceOverrides,
} from "@/utils/request/performance-config"

interface UseExportConfigOptions {
  config: Config
  schemaVersion: number
}

export function useExportConfig({ config, schemaVersion }: UseExportConfigOptions) {
  return useMutation({
    mutationFn: async (includeApiKeys: boolean) => {
      let exportConfig = config

      if (!includeApiKeys) {
        exportConfig = getObjectWithoutAPIKeys(config)
      }

      const performance = performanceOverridesSchema.safeParse(
        await storage.getItem(PERFORMANCE_STORAGE_KEY),
      )
      const json = JSON.stringify(
        {
          config: exportConfig,
          schemaVersion,
          ...(performance.success
            ? { performance: portablePerformanceOverrides(performance.data) }
            : {}),
          // Its own top-level key, in the same shape the Drive sync writes, so
          // one reader handles both routes and a file from either can be
          // imported by either. Older builds simply ignore it.
        },
        null,
        2,
      )
      const blob = new Blob([json], { type: "text/json" })
      saveAs(blob, `${kebabCase(APP_NAME)}-config-v${schemaVersion}.json`)
      return undefined
    },
    onSuccess: () => {
      toastManager.add({
        type: "success",
        title: i18n.t("options.preference.config.manualSync.exportSuccess"),
      })
    },
  })
}
