/**
 * A call to action carried alongside an error — "Upgrade", "Log in".
 * Described as data rather than a callback so the layer that raises the error
 * stays free of UI concerns, the action survives the trip across a message
 * port, and tests can assert on it without comparing functions. Whatever shows
 * the error (a toast, an inline alert) turns it into a button.
 */
export interface ErrorAction {
  /** Already localized. */
  label: string
  /** Absolute URL, opened through the background worker on click. */
  url: string
}

/**
 * Dunning, not cancellation: they already pay and the card just failed, so
 * sending them to pricing would invite an existing subscriber to subscribe
 * again — and a button reading "Upgrade" would say the wrong thing to someone
 * who already did.
 */
