// Controlled extension API fixture. This is deliberately NOT a service-worker benchmark.
export function installBrowserAPI({
  config,
  theme = "dark",
  locale = "en",
  backgroundDelay = 10,
  tabUrl = "https://example.com/article",
  failure,
  translated = false,
}) {
  const trace = (window.__uiTrace = {
    calls: [],
    commits: [],
    errors: [],
    shifts: [],
    longTasks: [],
  })
  const event = () => {
    const listeners = new Set()
    return {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      hasListener: (fn) => listeners.has(fn),
      emit: (...args) => listeners.forEach((fn) => fn(...args)),
      count: () => listeners.size,
    }
  }
  const changed = event()
  const values = { readFrogLiteConfig: config, theme }
  const call = async (name, delay, result) => {
    const item = { name, start: performance.now() }
    trace.calls.push(item)
    await new Promise((resolve) => setTimeout(resolve, delay))
    item.end = performance.now()
    return structuredClone(result)
  }
  const area = {
    onChanged: changed,
    async get(keys) {
      if (failure === "storage") throw new Error("fixture storage failure")
      const result =
        typeof keys === "string"
          ? { [keys]: values[keys] }
          : Array.isArray(keys)
            ? Object.fromEntries(keys.map((key) => [key, values[key]]))
            : values
      return call(`storage.get:${String(keys)}`, 5, result)
    },
    async set(next) {
      await call("storage.set", 5)
      const changes = Object.fromEntries(
        Object.entries(next).map(([key, value]) => [
          key,
          { oldValue: values[key], newValue: value },
        ]),
      )
      Object.assign(values, structuredClone(next))
      changed.emit(changes, "local")
    },
    async remove() {},
    async clear() {},
  }
  const runtimeMessages = event()
  const runtime = {
    id: "ui-production-fixture",
    getURL: (path) => new URL(path, location.origin).href,
    getManifest: () => ({ version: "0.2.5", manifest_version: 3 }),
    onMessage: runtimeMessages,
    onConnect: event(),
    getPlatformInfo: async () => ({ os: "linux", arch: "x86-64" }),
    openOptionsPage: async () => {},
    sendMessage(message, callback) {
      if (failure === "hang" && message.type === "getEnablePageTranslationByTabId") return undefined
      if (message.type === "tryToSetEnablePageTranslationByTabId") translated = message.data.enabled
      const response =
        message.type === "getEnablePageTranslationByTabId"
          ? translated
          : message.type === "getDetectedCode"
            ? "eng"
            : undefined
      const promise = call(`message:${message.type}`, backgroundDelay, response).then((res) => {
        const reply =
          failure === "message" && message.type === "getEnablePageTranslationByTabId"
            ? { err: { name: "Error", message: "fixture unavailable" } }
            : { res }
        callback?.(reply)
        return reply
      })
      return promise
    },
  }
  const api = {
    runtime,
    storage: { local: area, sync: area, session: area, onChanged: changed },
    tabs: {
      async query() {
        if (failure === "tabs") throw new Error("fixture tabs failure")
        return call("tabs.query", 15, tabUrl ? [{ id: 7, url: tabUrl, active: true }] : [])
      },
      get: async () => ({ id: 7, url: tabUrl }),
      reload: async () => {},
      create: async () => {},
      onUpdated: event(),
      onActivated: event(),
      sendMessage: (...args) => runtime.sendMessage(...args),
    },
    i18n: { getUILanguage: () => locale, getMessage: (key) => key },
    permissions: { contains: async () => true },
    commands: { getAll: async () => [] },
  }
  window.chrome = api
  window.browser = api
  window.__uiFixture = {
    values,
    changed,
    runtimeMessages,
    setFailure: (value) => {
      failure = value
    },
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberRoot: () => trace.commits.push(performance.now()),
    onCommitFiberUnmount: () => {},
  }
  new PerformanceObserver((list) =>
    trace.longTasks.push(
      ...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })),
    ),
  ).observe({ type: "longtask", buffered: true })
  new PerformanceObserver((list) =>
    trace.shifts.push(
      ...list
        .getEntries()
        .filter((e) => !e.hadRecentInput)
        .map((e) => e.value),
    ),
  ).observe({ type: "layout-shift", buffered: true })
  addEventListener("error", (e) => trace.errors.push(e.message))
  addEventListener("unhandledrejection", (e) => trace.errors.push(String(e.reason)))
  const observe = () => {
    const observer = new MutationObserver(() => {
      const controls = document.querySelectorAll('button, [role="switch"]')
      if (controls.length > 5 && !trace.meaningful) {
        trace.meaningful = performance.now()
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            trace.meaningfulPaint = performance.now()
          }),
        )
      }
      const translate =
        document.querySelector("[data-popup-translate]") ||
        [...document.querySelectorAll("button")].find((b) =>
          /^(Translate|Show original|翻译|显示原文)/i.test(b.textContent.trim()),
        )
      if (translate && !translate.disabled && !trace.interactive)
        trace.interactive = performance.now()
    })
    observer.observe(document, { childList: true, subtree: true, attributes: true })
  }
  observe()
}
