import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { Icon } from "@iconify/react/offline"
import { useSelector } from "@tanstack/react-store"
import { useState } from "react"
import { useAutosaveContext } from "@/components/form/use-autosave"
import { Button } from "@/components/ui/base-ui/button"
import { Field, FieldTitle } from "@/components/ui/base-ui/field"
import { InputGroup, InputGroupInput } from "@/components/ui/base-ui/input-group"
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/base-ui/popover"
import { i18n } from "@/utils/i18n"
import { hasLocalIcon } from "@/utils/iconify/local-icons"
import { cn } from "@/utils/styles/utils"
import { withForm } from "./form"
import { CURATED_ICON_OPTIONS } from "./icon-field-options"

interface IconPickerPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  previewIcon: string
  selectedIcon: string | undefined
  onSelect: (icon: string) => void
  disabled?: boolean
}

function IconPickerPopover({
  open,
  onOpenChange,
  previewIcon,
  selectedIcon,
  onSelect,
  disabled,
}: IconPickerPopoverProps) {
  return (
    <Popover
      open={!disabled && open}
      onOpenChange={(nextOpen) => {
        if (!disabled) onOpenChange(nextOpen)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={disabled}
            aria-label={i18n.t(
              "options.selectionToolbar.customActions.form.iconField.chooseAriaLabel",
            )}
          />
        }
      >
        {previewIcon && <Icon icon={previewIcon} />}
      </PopoverTrigger>

      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>
            {i18n.t("options.selectionToolbar.customActions.form.iconField.chooseTitle")}
          </PopoverTitle>
        </PopoverHeader>
        <div className="grid grid-cols-6 gap-1">
          {CURATED_ICON_OPTIONS.map((icon) => (
            <Button
              key={icon}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={icon}
              className={cn(selectedIcon === icon && "bg-muted text-foreground")}
              onClick={() => onSelect(icon)}
            >
              <Icon icon={icon} />
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export const IconField = withForm({
  ...{ defaultValues: {} as SelectionToolbarCustomAction },
  props: {
    readOnly: false as boolean,
  },
  render: function Render({ form, readOnly }) {
    const autosave = useAutosaveContext()
    const iconValue = useSelector(form.store, (state) => state.values.icon)
    const [iconPickerOpen, setIconPickerOpen] = useState(false)
    const hasError = !hasLocalIcon(iconValue?.trim() ?? "")
    const previewIcon = iconValue?.trim() ?? ""

    return (
      <form.AppField
        name="icon"
        validators={{
          onChange: ({ value }) => {
            if (!hasLocalIcon(value.trim())) {
              return i18n.t("options.selectionToolbar.customActions.errors.invalidIcon")
            }
            return undefined
          },
        }}
      >
        {(field) => (
          <Field>
            <FieldTitle>{i18n.t("options.selectionToolbar.customActions.form.icon")}</FieldTitle>
            <div className="flex items-center gap-2">
              <IconPickerPopover
                open={iconPickerOpen}
                onOpenChange={setIconPickerOpen}
                previewIcon={previewIcon}
                selectedIcon={field.state.value}
                disabled={readOnly}
                onSelect={(icon) => {
                  autosave.edit(() => field.handleChange(icon), { immediate: true })
                  setIconPickerOpen(false)
                }}
              />

              <InputGroup className="flex-1">
                <InputGroupInput
                  value={field.state.value ?? ""}
                  placeholder={i18n.t(
                    "options.selectionToolbar.customActions.form.iconField.inputPlaceholder",
                  )}
                  aria-invalid={hasError}
                  readOnly={readOnly}
                  onBlur={() => {
                    field.handleBlur()
                    void autosave.flush()
                  }}
                  onCompositionStart={() => autosave.beginComposition(field.name)}
                  onCompositionEnd={(event) => {
                    const value = event.currentTarget.value
                    autosave.endComposition(field.name, () => field.handleChange(value))
                  }}
                  onChange={(e) => {
                    const value = e.currentTarget.value
                    autosave.edit(() => field.handleChange(value))
                  }}
                />
                <></>
              </InputGroup>
            </div>
            {field.state.meta.errors.length > 0 && (
              <span className="text-sm font-normal text-destructive">
                {field.state.meta.errors.join(", ")}
              </span>
            )}
          </Field>
        )}
      </form.AppField>
    )
  },
})
