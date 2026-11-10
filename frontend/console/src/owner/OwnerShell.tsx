// Reusable owner shell (S4-FE-03): sidebar with restaurant identity and workspace navigation, a
// top bar and an optional AI side panel. RES-03 renders its dashboard pages inside this shell.
import type { ReactNode } from 'react';
import { ICONS, Icon, type IconName } from './icons';

export type OwnerPage = 'setup' | 'overview' | 'report' | 'performance' | 'menu' | 'actions';

const NAV: { id: OwnerPage; label: string; icon: IconName }[] = [
  { id: 'setup', label: 'Restaurant Setup', icon: 'store' },
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'report', label: 'AI Insight Report', icon: 'report' },
  { id: 'performance', label: 'Dish performance', icon: 'chart' },
  { id: 'menu', label: 'Menu', icon: 'menu' },
  { id: 'actions', label: 'Actions', icon: 'action' },
];

export interface OwnerShellProps {
  restaurantName: string;
  current: OwnerPage;
  onNavigate: (page: OwnerPage) => void;
  /** Shows the dot on Restaurant Setup while onboarding is unfinished. */
  setupIncomplete: boolean;
  topbar: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}

export function OwnerShell({
  restaurantName,
  current,
  onNavigate,
  setupIncomplete,
  topbar,
  aside,
  children,
}: OwnerShellProps) {
  return (
    <div className="owner-shell">
      <a className="owner-skip" href="#owner-content">
        Skip to content
      </a>
      <aside className="owner-sidebar" aria-label="Owner workspace">
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
            {NAV.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="owner-nav__item"
                  aria-current={current === item.id ? 'page' : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <span className="owner-nav__label">
                    <Icon name={item.icon} size={19} />
                    {item.label}
                  </span>
                  {item.id === 'setup' && setupIncomplete && (
                    <>
                      <Icon name="dot" size={6} />
                      <span className="owner-visually-hidden">(setup not finished)</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
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
