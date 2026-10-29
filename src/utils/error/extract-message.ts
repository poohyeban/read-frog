// Remote error bodies/messages can reflect Authorization headers or API keys.
// Only status codes cross the background → UI boundary; never expose raw text.
export async function extractErrorMessage(response: Response): Promise<string> {
  await response.body?.cancel()
  return `Provider request failed (HTTP ${response.status}). Check the configured service.`
}

export function extractAISDKErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const status = error.statusCode
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
      return `Provider request failed (HTTP ${status}). Check the configured service.`
  }
  return "Unexpected error occurred"
}
