// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DocumentTitleTask } from "@/entrypoints/content-runtime/host/translation-control/document-title-task"
import { beginPageTranslationSession, endPageTranslationSession } from "../../translation-session"
import { releaseWebPageContext, synchronizeWebPageContext } from "../../webpage-context"
const titleRequest = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<string>>())
vi.mock("@/utils/host/translate/translate-variants", () => ({
  translateTextForPageTitle: titleRequest,
}))
let task: DocumentTitleTask
let respond: (value: string) => void
beforeEach(() => {
  document.title = "Original title"
  document.body.innerHTML = "<article>A source</article><article id='b'>Unrelated source</article>"
  titleRequest.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = resolve
      }),
  )
  beginPageTranslationSession()
  synchronizeWebPageContext()
  task = new DocumentTitleTask(() => true)
  task.start()
})
afterEach(() => {
  task.dispose()
  endPageTranslationSession()
  releaseWebPageContext()
})
it("commits the title after unrelated post removal with one request", async () => {
  document.querySelector("#b")!.remove()
  synchronizeWebPageContext()
  respond("正确标题")
  await Promise.resolve()
  await Promise.resolve()
  expect(document.title).toBe("正确标题")
  expect(titleRequest).toHaveBeenCalledTimes(1)
})
it("rejects a changed source title before its observer gets a turn", async () => {
  respond("过期标题") // Queue the request continuation before the MutationObserver.
  document.title = "A genuinely new title"
  await Promise.resolve()
  expect(document.title).toBe("A genuinely new title")
  await Promise.resolve()
  expect(titleRequest).toHaveBeenCalledTimes(2) // One legitimate new source, no replay.
})
