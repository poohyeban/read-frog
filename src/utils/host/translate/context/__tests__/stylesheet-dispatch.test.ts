// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { resolvePageTranslationProvider } from "@/utils/providers/provider-ref"
import { translateTextCore } from "../../translate-text"
import { getOrCreateWebPageContext, releaseWebPageContext } from "../../webpage-context"
const io = vi.hoisted(() => ({
  glossary: vi.fn<(...args: any[]) => any>(),
  execute: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/glossary/active-matcher", () => ({ resolveGlossaryTerms: io.glossary }))
vi.mock("../../translation-executor", () => ({ executeTranslationPlan: io.execute }))
vi.mock("defuddle/full", () => ({
  default: class {
    constructor(private doc: Document) {}
    parse() {
      return { content: this.doc.body.innerHTML }
    }
  },
  createMarkdownContent: (html: string) =>
    new DOMParser().parseFromString(html, "text/html").body.textContent ?? "",
}))
beforeEach(() => {
  releaseWebPageContext()
  vi.resetAllMocks()
  document.head.innerHTML = "<style>.secret {color:blue}</style>"
  document.body.innerHTML =
    '<main role="feed"><article><p>Visible task source</p><aside class="secret">PRIVATE_PENDING_CONTEXT</aside></article></main>'
  io.glossary.mockResolvedValue({ terms: [], revision: 0 })
  io.execute.mockResolvedValue({ text: "Translated" })
})
afterEach(() => releaseWebPageContext())
const options = (context: Awaited<ReturnType<typeof getOrCreateWebPageContext>>) => ({
  text: "Visible task source",
  webPageContext: context!,
  providerConfig: resolvePageTranslationProvider(DEFAULT_CONFIG),
  langConfig: {
    sourceCode: "eng" as const,
    targetCode: "cmn" as const,
    level: DEFAULT_CONFIG.language.level,
  },
  promptConfig: DEFAULT_CONFIG.pageTranslation,
})
it("stylesheet changes during async glossary preparation cannot dispatch old context", async () => {
  const context = await getOrCreateWebPageContext(true, undefined, {
    source: document.querySelector("p"),
  })
  let release!: (value: unknown) => void
  io.glossary.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const task = translateTextCore(options(context)).catch((error) => error)
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  document.querySelector("style")!.textContent = ".secret {display:none}"
  release({ terms: [], revision: 0 })
  expect(await task).toMatchObject({ code: "CONTEXT_STALE" })
  expect(io.execute).not.toHaveBeenCalled()
  expect(context!.webContent).toContain("PRIVATE_PENDING_CONTEXT")
  const fresh = await getOrCreateWebPageContext(true, undefined, {
    source: document.querySelector("p"),
  })
  io.glossary.mockResolvedValue({ terms: [], revision: 0 })
  expect(await translateTextCore(options(fresh))).toBe("Translated")
  expect(io.execute).toHaveBeenCalledTimes(1)
  expect(io.execute.mock.calls[0]![0].request.webContent).not.toContain("PRIVATE_PENDING_CONTEXT")
})
it("CSS changes after dispatch cannot revoke an issued result", async () => {
  const context = await getOrCreateWebPageContext(true, undefined, {
    source: document.querySelector("p"),
  })
  let release!: (value: { text: string }) => void
  io.execute.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const task = translateTextCore(options(context))
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  document.querySelector("style")!.textContent = ".secret {display:none}"
  release({ text: "Translated" })
  expect(await task).toBe("Translated")
  expect(io.execute).toHaveBeenCalledTimes(1)
})

it("derived prompt values retain validation without adding wire or cache fields", async () => {
  const { inheritPromptContext } = await import("../prompt-guard")
  const context = await getOrCreateWebPageContext(true, undefined, {
    source: document.querySelector("p"),
  })
  const derived = inheritPromptContext(context, {
    webTitle: context!.webTitle,
    webContent: context!.webContent,
  })
  expect(structuredClone(derived)).toEqual(derived)
  const wire = JSON.stringify(derived)
  document.querySelector("style")!.textContent = ".secret {display:none}"
  await expect(
    translateTextCore({ ...options(context), webPageContext: derived }),
  ).rejects.toMatchObject({ code: "CONTEXT_STALE" })
  expect(JSON.stringify(derived)).toBe(wire)
  expect(io.execute).not.toHaveBeenCalled()
})

it("derived prompts follow an identical snapshot refreshed after heading replacement", async () => {
  const { inheritPromptContext, isPromptContextCurrent } = await import("../prompt-guard")
  const article = document.querySelector("article")!
  article.insertAdjacentHTML("afterbegin", "<h2>Same safe title</h2>")
  const read = () => getOrCreateWebPageContext(true, undefined, { source: article })
  const first = await read()
  const derived = inheritPromptContext(first, { webContent: first!.webContent })
  article.querySelector("h2")!.outerHTML = "<h2>Same safe title</h2>"
  expect(await read()).toBe(first)
  expect(isPromptContextCurrent(derived)).toBe(true)
  document.querySelector("style")!.textContent = ".secret {display:none}"
  expect(isPromptContextCurrent(derived)).toBe(false)
  expect(io.execute).not.toHaveBeenCalled()
})
