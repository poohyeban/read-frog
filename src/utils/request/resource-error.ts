/** Admission errors are independent of any translation or subtitle business. */
export class ResourceRejected extends Error {
  readonly isRetryable = false
  constructor(
    readonly code:
      | "attempts"
      | "input-limit"
      | "lease"
      | "queue-full"
      | "identity"
      | "configuration-changed",
  ) {
    super(`Request rejected: ${code}`)
    this.name = "ResourceRejected"
  }
}
