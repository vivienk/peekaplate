import type { OwnerPage } from './setup.ts';

export const OWNER_AUTH_PATH = '/owner-auth';

export const OWNER_PAGE_PATHS = {
  overview: '/overview',
  report: '/ai-insight-report',
  performance: '/dish-performance',
  menu: '/menu',
  actions: '/actions',
  setup: '/restaurant-setup',
} as const satisfies Record<OwnerPage, string>;

export const OWNER_PAGE_LABELS = {
  overview: 'Overview',
  report: 'AI Insight Report',
  performance: 'Dish performance',
  menu: 'Menu',
  actions: 'Actions',
  setup: 'Restaurant Setup',
} as const satisfies Record<OwnerPage, string>;

export function ownerPageForPath(pathname: string): OwnerPage | undefined {
  return (Object.keys(OWNER_PAGE_PATHS) as OwnerPage[]).find(
    (page) => OWNER_PAGE_PATHS[page] === pathname,
  );
}
