import { useRouterState } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import type { layout as layoutEn } from '@/locales/en/layout.ts';

type NavKey = keyof typeof layoutEn.nav;

/**
 * First-level path segments share their label with the sidebar nav entry for
 * the same destination (one name per place, per language). Deeper segments
 * are entity IDs and fall back to slug title-casing.
 */
const SEGMENT_TO_NAV: Partial<Record<string, NavKey>> = {
  invocations: 'toolSessions',
  contexts: 'contexts',
  messages: 'messages',
  stickers: 'botStickerSets',
  'image-generate': 'imageGenerate',
  'image-generations': 'imageGenerations',
  alarms: 'alarms',
  memories: 'memories',
  admins: 'botAdmins',
  'api-keys': 'apiKeys',
  models: 'models',
  'image-settings': 'imageSettings',
  chats: 'chats',
  developer: 'developer',
  settings: 'settings',
};

interface Crumb {
  title: string;
  link: string;
}

function useBreadcrumbs(): Crumb[] {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { t } = useTranslation();

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return [{ title: t('layout.nav.overview'), link: '/' }];
  }

  return segments.map((seg: string, i: number) => {
    const link = `/${segments.slice(0, i + 1).join('/')}`;
    const navKey = i === 0 ? SEGMENT_TO_NAV[seg] : undefined;
    const title =
      navKey === undefined
        ? seg.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
        : t(`layout.nav.${navKey}`);
    return { title, link };
  });
}

export function Breadcrumbs() {
  const items = useBreadcrumbs();
  if (items.length === 0) {
    return null;
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {items.map((item: Crumb, index: number) => (
          <Fragment key={item.title}>
            {index !== items.length - 1 && (
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href={item.link}>{item.title}</BreadcrumbLink>
              </BreadcrumbItem>
            )}
            {index < items.length - 1 && (
              <BreadcrumbSeparator className="hidden md:block">
                <ChevronRight className="size-3" />
              </BreadcrumbSeparator>
            )}
            {index === items.length - 1 && <BreadcrumbPage>{item.title}</BreadcrumbPage>}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
