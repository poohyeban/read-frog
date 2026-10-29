export const PROVIDER_SETUP_ERROR_NAME = "ProviderSetupError"

export class ProviderSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = PROVIDER_SETUP_ERROR_NAME
  }
}
