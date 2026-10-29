import type { APIProviderConfig } from "@/types/config/provider"
import { useSelector } from "@tanstack/react-store"
import { isDedicatedLLMProvider } from "@/types/config/provider"
import { PROVIDER_URL_PLACEHOLDERS } from "@/utils/constants/providers"
import { i18n } from "@/utils/i18n"
import { ConnectionTestButton } from "./components/connection-button"
import { withForm } from "./form"

export const ProviderURLField = withForm({
  ...{ defaultValues: {} as APIProviderConfig },
  render: function Render({ form }) {
    const providerConfig = useSelector(form.store, (state) => state.values)
    const providerType = providerConfig.provider

    const isOptionalBaseURL = isDedicatedLLMProvider(providerType)
    const labelText = `${i18n.t("options.apiProviders.form.fields.baseURL")}${
      isOptionalBaseURL ? ` (${i18n.t("options.apiProviders.form.fields.optional")})` : ""
    }`

    return (
      <form.AppField name="baseURL">
        {(field) => (
          <field.InputFieldAutoSave
            label={labelText}
            placeholder={PROVIDER_URL_PLACEHOLDERS[providerType]}
            labelExtra={
              providerType === "ollama" && <ConnectionTestButton providerConfig={providerConfig} />
            }
          />
        )}
      </form.AppField>
    )
  },
})
