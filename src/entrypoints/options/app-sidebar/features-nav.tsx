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
