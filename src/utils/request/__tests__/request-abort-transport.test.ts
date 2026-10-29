import { createServer } from "node:http"
import { expect, it } from "vitest"
import { RequestQueue } from "../request-queue"

it("propagates scope cancellation to the actual fetch transport and closes the response", async () => {
  let opened!: () => void
  let closed!: () => void
  const requestOpened = new Promise<void>((resolve) => {
    opened = resolve
  })
  const responseClosed = new Promise<void>((resolve) => {
    closed = resolve
  })
  const server = createServer((_request, response) => {
    response.once("close", closed)
    opened()
    // Keep headers pending so this verifies network cancellation, not only a
    // fulfilled fetch promise or a mocked AbortSignal listener.
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture address")
    const queue = new RequestQueue({
      rate: 100,
      capacity: 10,
      maxConcurrent: 1,
      timeoutMs: 5000,
      maxRetries: 1,
      baseRetryDelayMs: 10,
    })
    const pending = queue.enqueue(
      (signal) => fetch(`http://127.0.0.1:${address.port}`, { signal }),
      Date.now(),
      "fetch",
      ["session"],
    )
    void pending.catch(() => {})
    await requestOpened
    queue.cancelByScope("session")
    await expect(pending).rejects.toThrow(/cancelled/i)
    await responseClosed
    await expect(queue.enqueue(async () => "next", Date.now(), "next")).resolves.toBe("next")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
