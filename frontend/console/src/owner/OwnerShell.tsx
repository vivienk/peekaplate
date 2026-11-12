// Reusable owner shell (S4-FE-03, S6-FE-14): sidebar with restaurant identity and workspace
// navigation, a top bar and an optional AI side panel. RES-03 renders its dashboard pages inside
// this shell. Pages the owner may not open yet stay visible but locked (aria-disabled).
import type { ReactNode } from 'react';
import { ICONS, Icon, type IconName } from './icons';
import type { OwnerPage } from './setup';

export type { OwnerPage } from './setup';

// Restaurant Setup sits last (design feedback, 10 Nov): the dashboard pages come first.
const NAV: { id: OwnerPage; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'report', label: 'AI Insight Report', icon: 'report' },
  { id: 'performance', label: 'Dish performance', icon: 'chart' },
  { id: 'menu', label: 'Menu', icon: 'menu' },
  { id: 'actions', label: 'Actions', icon: 'action' },
  { id: 'setup', label: 'Restaurant Setup', icon: 'store' },
];

const LOCKED_HINT_ID = 'owner-nav-locked-hint';

export interface OwnerShellProps {
  /** The venue every page in this shell is scoped to. */
  venueId: string;
  restaurantName: string;
  current: OwnerPage;
  onNavigate: (page: OwnerPage) => void;
  /** Pages the owner may open; the rest are shown locked. Defaults to all pages. */
  available?: ReadonlySet<OwnerPage>;
  topbar: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}

export function OwnerShell({
  venueId,
  restaurantName,
  current,
  onNavigate,
  available,
  topbar,
  aside,
  children,
}: OwnerShellProps) {
  const isOpen = (page: OwnerPage) => !available || available.has(page);
  const anyLocked = NAV.some((item) => !isOpen(item.id));
  return (
    <div className="owner-shell" data-venue-id={venueId}>
      <a className="owner-skip" href="#owner-content">
        Skip to content
      </a>
      <div className="owner-sidebar">
        <div className="owner-brand">
          <div className="owner-brand__row">
            <img src={ICONS.logo} alt="" width={28} height={28} />
            <span className="owner-brand__name">PeekaPlate</span>
          </div>
          <span className="owner-brand__sub">Owner Dashboard</span>
        </div>
        <div className="owner-identity">
          <span className="owner-identity__name">{restaurantName}</span>
          <span className="owner-identity__kind">Restaurant</span>
        </div>
        <span className="owner-nav-label" id="owner-nav-label">
          Workspace
        </span>
        <nav className="owner-nav" aria-labelledby="owner-nav-label">
          <ul>
            {NAV.map((item) => {
              const open = isOpen(item.id);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className="owner-nav__item"
                    aria-current={current === item.id ? 'page' : undefined}
                    aria-disabled={open ? undefined : true}
                    aria-describedby={open ? undefined : LOCKED_HINT_ID}
                    onClick={() => {
                      if (open) onNavigate(item.id);
                    }}
                  >
                    <span className="owner-nav__label">
                      <Icon name={item.icon} size={19} />
                      {item.label}
                    </span>
                    {!open && <Icon name="lock" size={16} />}
                  </button>
                </li>
              );
            })}
          </ul>
          {anyLocked && (
            <p className="owner-nav-hint" id={LOCKED_HINT_ID}>
              These pages open after you publish your menu.
            </p>
          )}
        </nav>
      </div>
      <div className="owner-main">
        <header className="owner-topbar">{topbar}</header>
        <main id="owner-content" className="owner-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      {aside}
    </div>
  );
}
