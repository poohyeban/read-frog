/** Uses the existing manager's start/stop completion; no parallel lifecycle. */
export async function applyPageCommand(
  manager: {
    isActive: boolean
    start: () => Promise<void>
    stop: (options: { userInitiated: boolean }) => void
  },
  command: { enabled: boolean; url: string },
  getUrl = () => window.location.href,
) {
  if (getUrl() !== command.url) throw new Error("Page changed before translation command")
  if (command.enabled) await manager.start()
  // Always stop, including a start that is still awaiting configuration.
  else manager.stop({ userInitiated: true })
  if (getUrl() !== command.url || manager.isActive !== command.enabled)
    throw new Error("Page manager did not apply translation command")
  return { enabled: manager.isActive, url: getUrl() }
}
