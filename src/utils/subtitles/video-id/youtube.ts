const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
])

export function getYoutubeVideoId(url = window.location.href): string | null {
  try {
    const parsed = new URL(url)
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
      return null
    const parts = parsed.pathname.split("/").filter(Boolean)
    const id =
      parsed.hostname === "youtu.be"
        ? parts[0]
        : YOUTUBE_HOSTS.has(parsed.hostname)
          ? parts[0] === "watch"
            ? parsed.searchParams.get("v")
            : ["shorts", "live", "embed"].includes(parts[0] ?? "")
              ? parts[1]
              : null
          : null
    return id && /^[\w-]{11}$/.test(id) ? id : null
  } catch {
    return null
  }
}
