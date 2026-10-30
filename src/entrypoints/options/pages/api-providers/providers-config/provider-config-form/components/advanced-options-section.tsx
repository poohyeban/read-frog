import type { ReactNode } from "react"
import { Icon } from "@iconify/react/offline"
import { useState } from "react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/base-ui/collapsible"
import { FieldGroup } from "@/components/ui/base-ui/field"
import { preloadJSONCodeEditor } from "@/components/ui/json-code-editor"
import { i18n } from "@/utils/i18n"
import { cn } from "@/utils/styles/utils"

interface AdvancedOptionsSectionProps {
  children: ReactNode
}

export function AdvancedOptionsSection({ children }: AdvancedOptionsSectionProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open)
        if (open) setHasOpened(true)
      }}
    >
      <CollapsibleTrigger
        onPointerEnter={preloadJSONCodeEditor}
        onFocus={preloadJSONCodeEditor}
        className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <Icon
          icon="tabler:chevron-right"
          className={cn("size-4 transition-transform duration-200", isOpen && "rotate-90")}
        />
        <span>{i18n.t("options.apiProviders.form.advancedOptions")}</span>
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        {hasOpened && <FieldGroup className="pt-4">{children}</FieldGroup>}
      </CollapsibleContent>
    </Collapsible>
  )
}
