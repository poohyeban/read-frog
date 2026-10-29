import { Icon } from "@iconify/react/offline"
import { Link, useLocation } from "react-router"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/base-ui/sidebar"
import { i18n } from "@/utils/i18n"
export function FeaturesNav() {
  const { pathname } = useLocation()
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{i18n.t("options.sidebar.features")}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {[
            {
              path: "/custom-actions",
              label: i18n.t("options.selectionToolbar.customActions.title"),
              icon: "tabler:sparkles",
            },
            {
              path: "/input-translation",
              label: i18n.t("options.inputTranslation.title"),
              icon: "tabler:keyboard",
            },
            {
              path: "/floating-button",
              label: i18n.t("options.floatingButton.title"),
              icon: "tabler:click",
            },
            {
              path: "/advanced/glossary",
              label: i18n.t("options.advanced.glossary.title"),
              icon: "tabler:book",
            },
            {
              path: "/page-translation",
              label: i18n.t("options.translation.title"),
              icon: "tabler:language",
            },
            {
              path: "/selection-toolbar",
              label: i18n.t("options.selectionToolbar.title"),
              icon: "tabler:cursor-text",
            },
            {
              path: "/context-menu",
              label: i18n.t("options.contextMenu.title"),
              icon: "tabler:click",
            },
          ].map((item) => (
            <SidebarMenuItem key={item.path}>
              <SidebarMenuButton
                render={<Link to={item.path} />}
                isActive={pathname.startsWith(item.path)}
              >
                <Icon icon={item.icon} />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
