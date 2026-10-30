import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve, extname } from "node:path"
export async function serveBuild(directory) {
  const root = resolve(directory)
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
  }
  const server = createServer(async (req, res) => {
    try {
      const file = resolve(root, `.${new URL(req.url, "http://localhost").pathname}`)
      if (!file.startsWith(`${root}/`)) throw new Error("path")
      const bytes = await readFile(file)
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "Cache-Control": "public,max-age=3600",
      })
      res.end(bytes)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}
