import "@/utils/zod-config"
import { QueryClientProvider } from "@tanstack/react-query"
import { createStore, Provider as JotaiProvider } from "jotai"
import * as React from "react"
import { ThemeProvider } from "@/components/providers/theme-provider"
import { RecoveryBoundary } from "@/components/recovery/recovery-boundary"
import { AnchoredToastProvider, ToastProvider } from "@/components/ui/base-ui/toast"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { configAtom } from "@/utils/atoms/config"
import { baseThemeModeAtom } from "@/utils/atoms/theme"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { initI18n } from "@/utils/i18n"
import { LocaleBoundary } from "@/utils/i18n/locale-boundary"
import { renderPersistentReactRoot } from "@/utils/react-root"
import { queryClient } from "@/utils/tanstack-query"
import { getLocalThemeMode } from "@/utils/theme"
import App from "./app"
import { createPopupSession, withDeadline } from "./atoms/session"
import "@/utils/iconify/local-icons"
import "@fontsource-variable/inter/index.css"
import "@/assets/styles/text-small.css"
import "@/assets/styles/theme.css"

async function initApp() {
  const root = document.getElementById("root")!
  root.className = "text-base antialiased w-[320px] bg-background"
  const store = createStore()
  const session = createPopupSession(store)
  window.addEventListener("pagehide", () => session.dispose(), { once: true })
  // Page state starts in parallel and cannot block language/provider/settings controls.
  const pageStateReady = session.start()
  const [configValue, themeMode] = await Promise.all([
    withDeadline(getLocalConfig()),
    withDeadline(getLocalThemeMode()),
  ])
  const config = configValue ?? DEFAULT_CONFIG
  await initI18n(config.uiLanguage)
  store.set(configAtom, config)
  store.set(baseThemeModeAtom, themeMode)
  // Coalesce an already-nearby worker reply before the expensive first render.
  // Two frames is a hard budget: a slow/unavailable worker still cannot hold
  // configuration controls behind its full RPC timeout.
  await withDeadline(pageStateReady, 32).catch(() => {})

  renderPersistentReactRoot(
    root,
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <ThemeProvider>
            <TooltipProvider>
              <LocaleBoundary>
                <ToastProvider>
                  <AnchoredToastProvider>
                    <RecoveryBoundary>
                      <App />
                    </RecoveryBoundary>
                  </AnchoredToastProvider>
                </ToastProvider>
              </LocaleBoundary>
            </TooltipProvider>
          </ThemeProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  )
}

void initApp().catch(() => {
  // Storage may fail before React/i18n exist. Never display editable default
  // settings over an unread configuration. Native localized recovery remains usable.
  const root = document.getElementById("root")!
  const message = document.createElement("p")
  message.textContent =
    "Read Frog Lite — " +
    (navigator.language.startsWith("zh") ? "无法读取设置" : "Could not load settings")
  const retry = document.createElement("button")
  retry.type = "button"
  retry.textContent = navigator.language.startsWith("zh") ? "重试" : "Retry"
  retry.onclick = () => location.reload()
  root.replaceChildren(message, retry)
  root.style.padding = "16px"
})
