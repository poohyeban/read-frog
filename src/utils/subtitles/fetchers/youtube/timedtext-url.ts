/** Native captions are page-provided data, not an arbitrary fetch capability. */
export function isYoutubeTimedtextUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname) &&
      url.pathname === "/api/timedtext" &&
      !url.port
    )
  } catch {
    return false
  }
}
