import { describe, expect, it } from "vitest"
import { isYoutubeTimedtextUrl } from "../fetchers/youtube/timedtext-url"
import { getYoutubeVideoId } from "../video-id/youtube"

describe("YouTube URL boundaries", () => {
  it("extracts native watch, short link, shorts, live and embed IDs", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?t=5",
      ...["shorts", "live", "embed"].map((path) => `https://www.youtube.com/${path}/dQw4w9WgXcQ`),
    ])
      expect(getYoutubeVideoId(url)).toBe("dQw4w9WgXcQ")
  })
  it("rejects malformed IDs, untrusted hosts and embedded credentials", () => {
    for (const url of [
      "not a URL",
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=bad",
      "https://secret@youtube.com/watch?v=dQw4w9WgXcQ",
    ])
      expect(getYoutubeVideoId(url)).toBeNull()
  })
  it("limits native caption requests to YouTube HTTPS timedtext", () => {
    expect(
      isYoutubeTimedtextUrl("https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&pot=native-token"),
    ).toBe(true)
    for (const url of [
      "https://evil.test/api/timedtext",
      "http://www.youtube.com/api/timedtext",
      "https://youtube.com.evil.test/api/timedtext",
      "https://user:password@youtube.com/api/timedtext",
      "https://youtube.com/watch",
      "https://youtube.com:8443/api/timedtext",
    ])
      expect(isYoutubeTimedtextUrl(url)).toBe(false)
  })
})
