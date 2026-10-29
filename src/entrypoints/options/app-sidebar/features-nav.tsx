import type { ReactNode } from "react"
import { Icon } from "@iconify/react"
import { useState } from "react"
import { Link, useLocation } from "react-router"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/base-ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/base-ui/sidebar"
import { i18n } from "@/utils/i18n"

const OVERLAY_TOOLS_PATHS = ["/floating-button", "/selection-toolbar", "/context-menu"] as const
/**
 * The three in-extension translation pages. Grouped because they are one feature
 * seen in three surfaces — a page, a video, a text box — and listing them flat
 * put three of the eight top-level entries on the same subject.
 *
 * `startsWith`, because two of them own detail pages (`/page-translation/prompts`
 * and the rest), and the group has to stay lit while one is open.
 */
const TRANSLATION_PATHS = ["/page-translation", "/video-subtitles", "/input-translation"] as const

export function FeaturesNav() {
  const { pathname } = useLocation()
  const isOverlayToolsActive = OVERLAY_TOOLS_PATHS.includes(pathname)
  const isTranslationActive = TRANSLATION_PATHS.some((path) => pathname.startsWith(path))
  // `startsWith`, so the group stays lit while a single glossary is open on
  // `/advanced/glossary/:glossaryId`.
  const isAdvancedActive = pathname.startsWith("/advanced")

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{i18n.t("options.sidebar.features")}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/page-translation" />}
              isActive={isTranslationActive}
            >
              <Icon icon="tabler:language" />
              <span>{i18n.t("options.translation.title")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <CollapsibleNavGroup active={isOverlayToolsActive}>
            <SidebarMenuItem>
              <CollapsibleTrigger
                render={
                  <SidebarMenuButton
                    isActive={isOverlayToolsActive}
                    tooltip={i18n.t("options.overlayTools.title")}
                  />
                }
              >
                <Icon icon="tabler:layers-intersect" />
                <span>{i18n.t("options.overlayTools.title")}</span>
                <Icon
                  icon="tabler:chevron-right"
                  className="ml-auto transition-transform duration-200 group-data-open/collapsible:rotate-90"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      render={<Link to="/floating-button" />}
                      isActive={pathname === "/floating-button"}
                    >
                      <span>{i18n.t("options.floatingButton.title")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      render={<Link to="/selection-toolbar" />}
                      isActive={pathname === "/selection-toolbar"}
                    >
                      <span>{i18n.t("options.selectionToolbar.title")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      render={<Link to="/context-menu" />}
                      isActive={pathname === "/context-menu"}
                    >
                      <span>{i18n.t("options.contextMenu.title")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </CollapsibleNavGroup>

          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/tts" />}
              isActive={pathname === "/tts"}
              tooltip={i18n.t("options.tts.title")}
            >
              <Icon icon="tabler:speakerphone" />
              <span>{i18n.t("options.tts.title")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <CollapsibleNavGroup active={isAdvancedActive}>
            <SidebarMenuItem>
              <CollapsibleTrigger
                render={
                  <SidebarMenuButton
                    isActive={isAdvancedActive}
                    tooltip={i18n.t("options.advanced.title")}
                  />
                }
              >
                <Icon icon="tabler:flask" />
                <span>{i18n.t("options.advanced.title")}</span>
                <Icon
                  icon="tabler:chevron-right"
                  className="ml-auto transition-transform duration-200 group-data-open/collapsible:rotate-90"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      render={<Link to="/advanced/glossary" />}
                      isActive={pathname.startsWith("/advanced/glossary")}
                    >
                      <span>{i18n.t("options.advanced.glossary.title")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </CollapsibleNavGroup>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/**
 * A feature group that opens whenever the route lands on one of its pages — from a link, the
 * command palette or a URL as much as from the sidebar — and otherwise opens and closes only by
 * hand. Base UI reads `defaultOpen` once, so a route-driven `defaultOpen` neither opened the
 * group nor stayed quiet about changing.
 */
function CollapsibleNavGroup({ active, children }: { active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(active)
  // Adjusted while rendering rather than in an effect, so the group opens with the page instead of
  // a frame later. Comparing booleans, one update settles it.
  const [wasActive, setWasActive] = useState(active)
  if (active !== wasActive) {
    setWasActive(active)
    if (active) setOpen(true)
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
      {children}
    </Collapsible>
  )
}
