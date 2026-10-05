import { Link, useLocation } from '@tanstack/react-router';
import {
  Bell,
  Brain,
  Bug,
  Cpu,
  FileText,
  ImagePlus,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Settings,
  Shield,
  Sticker,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

interface NavGroup {
  label: string;
  items: NavItem[];
}

interface NavItem {
  title: string;
  url: string;
  icon: typeof LayoutDashboard;
}

export default function AppSidebar({
  username,
  onSignOut,
}: {
  readonly username: string;
  readonly onSignOut: () => void;
}) {
  const { pathname } = useLocation();
  const { t } = useTranslation();

  // Built on render so language switches re-label the sidebar.
  const navGroups: NavGroup[] = [
    {
      label: t('layout.nav.observe'),
      items: [
        { title: t('layout.nav.overview'), url: '/', icon: LayoutDashboard },
        { title: t('layout.nav.toolSessions'), url: '/invocations', icon: Zap },
        { title: t('layout.nav.contexts'), url: '/contexts', icon: MessageSquare },
        { title: t('layout.nav.messages'), url: '/messages', icon: FileText },
        { title: t('layout.nav.botStickerSets'), url: '/stickers', icon: Sticker },
        { title: t('layout.nav.imageGenerate'), url: '/image-generate', icon: ImagePlus },
        { title: t('layout.nav.imageGenerations'), url: '/image-generations', icon: ImagePlus },
      ],
    },
    {
      label: t('layout.nav.manage'),
      items: [
        { title: t('layout.nav.alarms'), url: '/alarms', icon: Bell },
        { title: t('layout.nav.memories'), url: '/memories', icon: Brain },
        { title: t('layout.nav.botAdmins'), url: '/admins', icon: Shield },
        { title: t('layout.nav.apiKeys'), url: '/api-keys', icon: KeyRound },
        { title: t('layout.nav.models'), url: '/models', icon: Cpu },
        { title: t('layout.nav.imageSettings'), url: '/image-settings', icon: Settings },
        { title: t('layout.nav.chats'), url: '/chats', icon: MessagesSquare },
        { title: t('layout.nav.developer'), url: '/developer', icon: Bug },
      ],
    },
    {
      label: t('layout.nav.account'),
      items: [{ title: t('layout.nav.settings'), url: '/settings', icon: Settings }],
    },
  ];

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/" aria-label="Plastic Wan Admin">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 shrink-0 items-center justify-center rounded-md">
                  <Zap className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Plastic Wan</span>
                  <span className="text-muted-foreground truncate text-xs">{t('layout.misc.admin')}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="overflow-x-hidden">
        {navGroups.map((group) => (
          <SidebarGroup key={group.label} className="py-0">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = item.url === '/' ? pathname === '/' : pathname.startsWith(item.url);
                return (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild tooltip={item.title} isActive={isActive}>
                      <Link to={item.url} aria-label={item.title}>
                        <Icon className="size-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <button type="button" onClick={onSignOut} className="flex w-full items-center gap-2">
                <div className="bg-muted flex aspect-square size-8 shrink-0 items-center justify-center rounded-full">
                  <LogOut className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{username}</span>
                  <span className="text-muted-foreground truncate text-xs">{t('layout.misc.signOut')}</span>
                </div>
              </button>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
