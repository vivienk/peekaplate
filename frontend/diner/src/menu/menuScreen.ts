import { suspendLiveTracking } from '../tracking';
import type { MenuToken } from '../tracking/delivery';
import { menuMode } from './config';
import { renderDishDetail } from './dishDetail';
import type { FixtureScenario } from './fixtures';
import { createFixtureMenuSource, demoBundle } from './fixtures';
import { formatPrice } from './price';
import { createMenuRefresher, type MenuRefresher } from './refresh';
import { menuRouteFromPath } from './route';
import {
  bindMenuSearch,
  SEARCH_ALL_CATEGORY_ID,
  searchEmptyMarkup,
  searchPanelMarkup,
} from './searchView';
import type { CompleteDish, Menu, MenuLoadResult } from './types';

const SCENARIO_NAMES: ReadonlySet<FixtureScenario> = new Set<FixtureScenario>([
  'demo',
  'edge-cases',
  'withdrawal',
  'layout-20',
  'empty',
  'unavailable',
  'error',
  'offline',
]);

const FIXTURE_LABEL = 'Fixture data';
const ALL_CATEGORY_ID = SEARCH_ALL_CATEGORY_ID;

let menuObserver: IntersectionObserver | null = null;
let activeCategoryId: string | null = null;
let openerDishId: string | null = null;
// True while the screen is showing fixture data. Only then may it show the "Fixture data"
// label and the demo restaurant name; real menus must never show either.
let fixtureMode = true;
// The current menu token and whether live tracking was switched on, kept in memory for the visit.
let menuToken: MenuToken | null = null;
let liveTrackingOn = false;
// The re-read timer for the live menu. Only one exists at a time; mounting again stops the old one.
let activeRefresher: MenuRefresher | null = null;
let activeLoad: AbortController | null = null;
// The open search query (null when the bar is closed), kept across dish detail and back.
let searchQuery: string | null = null;

function disposeObserver(): void {
  menuObserver?.disconnect();
  menuObserver = null;
}

function scenarioFromQuery(): FixtureScenario {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('scenario') ?? 'demo';
  return SCENARIO_NAMES.has(value as FixtureScenario) ? (value as FixtureScenario) : 'demo';
}

function delayFromQuery(): number | undefined {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('delayMs');
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// INTERIM: loading and error states have no restaurant name from the data, so a live menu uses
// a neutral heading. Design confirmation pending (open question 3 in the DIN-03 ticket).
function stateHeading(): string {
  return fixtureMode ? demoBundle.restaurant.name : 'Menu';
}

function fixtureNotice(): string {
  return fixtureMode ? `<p class="pp-notice">${FIXTURE_LABEL}</p>` : '';
}

function renderLoading(container: HTMLElement): void {
  container.innerHTML = `
    <h1 class="pp-sr-only">${escapeHtml(stateHeading())}</h1>
    <div class="pp-menu pp-menu--loading" role="status" aria-live="polite">
      <div class="pp-spinner" aria-hidden="true"></div>
      <p class="pp-loading-text">Loading menu…</p>
      ${fixtureNotice()}
    </div>
  `;
}

function renderFailure(
  container: HTMLElement,
  status: MenuLoadResult['status'],
  onRetry?: () => void,
): void {
  const messages: Record<string, string> = {
    empty: 'No dishes are available right now.',
    unavailable: 'This menu is unavailable right now.',
    error: 'We could not load the menu. Please try again.',
    offline: 'You appear to be offline. Please check your connection.',
  };
  const showRetry = (status === 'error' || status === 'offline') && Boolean(onRetry);
  container.innerHTML = `
    <h1 class="pp-sr-only">${escapeHtml(stateHeading())}</h1>
    <div class="pp-menu pp-menu--state" role="status" aria-live="polite">
      <p class="pp-state-text">${escapeHtml(messages[status] ?? 'We could not load the menu.')}</p>
      ${showRetry ? '<button class="pp-button" type="button" data-retry>Try again</button>' : ''}
      ${fixtureNotice()}
    </div>
  `;
  if (showRetry && onRetry) {
    container.querySelector<HTMLButtonElement>('[data-retry]')?.addEventListener('click', () => {
      onRetry();
    });
  }
}

function renderCard(dish: CompleteDish): string {
  const image = dish.images?.card;
  const imageMarkup = image
    ? `<img class="pp-card__image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" width="${image.width}" height="${image.height}" loading="lazy" />`
    : `<div class="pp-card__image pp-card__image--missing" aria-hidden="true"></div>`;

  return `
    <article class="pp-card pp-card--dim" data-dish-id="${escapeHtml(dish.dishId)}">
      <div class="pp-card__media">${imageMarkup}</div>
      <div class="pp-card__body">
        <p class="pp-card__category">${escapeHtml(dish.categoryName)}</p>
        <h2 class="pp-card__name"><button type="button" class="pp-card__open" data-open-dish-id="${escapeHtml(dish.dishId)}" aria-label="Open ${escapeHtml(dish.name)}"><span class="pp-card__name-text">${escapeHtml(dish.name)}</span></button></h2>
        <p class="pp-card__price">${escapeHtml(formatPrice(dish.price))}</p>
        <button class="pp-card__save" type="button" aria-label="Save ${escapeHtml(dish.name)} (not available yet)" disabled>
        <span aria-hidden="true">♡</span><span aria-hidden="true">Save</span>
        </button>
        <p class="pp-card__description">${escapeHtml(dish.description)}</p>
      </div>
    </article>
  `;
}

function renderPlaceholderCard(): string {
  return `
    <article class="pp-card pp-card--placeholder pp-card--dim" aria-disabled="true">
      <div class="pp-card__media pp-card__image--missing" aria-hidden="true"></div>
      <div class="pp-card__body">
        <p class="pp-card__placeholder">More information needed — pending restaurant input</p>
      </div>
    </article>
  `;
}
function renderMenu(
  container: HTMLElement,
  menu: Menu,
  onOpenDetail: (dish: CompleteDish) => void,
): void {
  disposeObserver();

  const categories = menu.categories;
  const current = activeCategoryId;
  const selectedId =
    current !== null &&
    (current === ALL_CATEGORY_ID || categories.some((c) => c.categoryId === current))
      ? current
      : ALL_CATEGORY_ID;
  activeCategoryId = selectedId;

  const tabs = [
    { categoryId: ALL_CATEGORY_ID, name: 'All' },
    ...categories.map((c) => ({ categoryId: c.categoryId, name: c.name })),
  ];
  const blocks = [
    { categoryId: ALL_CATEGORY_ID, dishes: categories.flatMap((c) => c.dishes) },
    ...categories.map((c) => ({ categoryId: c.categoryId, dishes: c.dishes })),
  ];

  container.innerHTML = `
    <div class="pp-menu">
      <h1 class="pp-sr-only">${escapeHtml(menu.restaurant.name)}</h1>
      <header class="pp-header">
        <button class="pp-saved" type="button" aria-label="Saved dishes (not available yet)" disabled>
          <span class="pp-saved__icon" aria-hidden="true">♥</span>
        </button>
        <div class="pp-logo">
          <span class="pp-logo__emblem" aria-hidden="true"></span>
          <span class="pp-logo__name">${escapeHtml(menu.restaurant.name)}</span>
        </div>
        <button class="pp-search" type="button" aria-label="Search menu" aria-expanded="false" aria-controls="pp-search-panel">
          <span aria-hidden="true">⌕</span>
        </button>
      </header>
      ${
        import.meta.env.VITE_OWNER_SIGN_IN_URL
          ? `<p class="pp-owner-link-wrap"><a class="pp-owner-link" href="${escapeHtml(import.meta.env.VITE_OWNER_SIGN_IN_URL)}" target="_blank" rel="noopener noreferrer">Restaurant owner? Sign in</a></p>`
          : ''
      }
      ${searchPanelMarkup()}

      <nav class="pp-tabs" aria-label="Menu categories">
        ${tabs
          .map(
            (category) => `
              <button class="pp-tab${category.categoryId === selectedId ? ' pp-tab--active' : ''}" type="button" data-category-id="${escapeHtml(category.categoryId)}" aria-pressed="${category.categoryId === selectedId}">
                ${escapeHtml(category.name)}
              </button>
            `,
          )
          .join('')}
      </nav>

      <section class="pp-dishes" aria-live="polite">
        ${blocks
          .map((category) => {
            const cards = category.dishes
              .map((dish) =>
                dish.kind === 'complete' ? renderCard(dish) : renderPlaceholderCard(),
              )
              .join('');
            return `<div class="pp-category" data-category-id="${escapeHtml(category.categoryId)}" ${category.categoryId === selectedId ? '' : 'hidden'}>${cards}</div>`;
          })
          .join('')}
      </section>
      ${searchEmptyMarkup()}

      <p class="pp-end">End of menu</p>
      ${menu.notice ? `<p class="pp-notice">${escapeHtml(menu.notice)}</p>` : ''}
      <p class="pp-notice">Save and Compare are not available yet.</p>
    </div>
  `;

  const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.pp-tab'));
  const categoryBlocks = Array.from(container.querySelectorAll<HTMLElement>('.pp-category'));

  const selectCategory = (target: string | null) => {
    activeCategoryId = target;
    tabButtons.forEach((item) => {
      const selected = item.dataset.categoryId === target;
      item.classList.toggle('pp-tab--active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    categoryBlocks.forEach((block) => {
      block.hidden = block.dataset.categoryId !== target;
    });
  };

  const search = bindMenuSearch(container, {
    menu,
    query: searchQuery,
    onQueryChange: (query) => {
      searchQuery = query;
    },
    activeCategoryId: () => activeCategoryId ?? ALL_CATEGORY_ID,
    selectAllCategories: () => selectCategory(ALL_CATEGORY_ID),
  });

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      selectCategory(button.dataset.categoryId ?? null);
      search.refresh();
    });
  });

  const cards = Array.from(container.querySelectorAll<HTMLElement>('.pp-card--dim'));
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          entry.target.classList.toggle('pp-card--inview', entry.isIntersecting);
        });
      },
      { threshold: 0.1 },
    );
    menuObserver = observer;
    cards.forEach((card) => observer.observe(card));
  } else {
    cards.forEach((card) => card.classList.add('pp-card--inview'));
  }

  const dishMap = new Map<string, CompleteDish>();
  categories.forEach((category) => {
    category.dishes.forEach((dish) => {
      if (dish.kind === 'complete') dishMap.set(dish.dishId, dish);
    });
  });

  const open = (dish: CompleteDish) => {
    openerDishId = dish.dishId;
    onOpenDetail(dish);
  };

  container.querySelectorAll<HTMLElement>('.pp-card[data-dish-id]').forEach((card) => {
    const dishId = card.dataset.dishId;
    const dish = dishId ? dishMap.get(dishId) : undefined;
    if (!dish) return;
    card.style.cursor = 'pointer';
    card.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.pp-card__save') || target.closest('.pp-card__open')) return;
      open(dish);
    });
    card
      .querySelector<HTMLButtonElement>('.pp-card__open')
      ?.addEventListener('click', () => open(dish));
  });

  container.querySelectorAll<HTMLImageElement>('img.pp-card__image').forEach((img) => {
    const handleFailure = () => {
      const missing = document.createElement('div');
      missing.className = 'pp-card__image pp-card__image--missing';
      missing.setAttribute('aria-hidden', 'true');
      img.replaceWith(missing);
    };
    img.addEventListener('error', handleFailure);
    if (img.complete && img.naturalWidth === 0) {
      handleFailure();
    }
  });
}

function focusAfterRetry(container: HTMLElement, succeeded: boolean): void {
  if (succeeded) {
    // Focus the hidden h1 that names the restaurant to establish context for screen reader users
    const heading = container.querySelector<HTMLElement>('h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  } else {
    // If retry fails again, keep focus on the retry button or state text
    const retryBtn = container.querySelector<HTMLButtonElement>('[data-retry]');
    if (retryBtn) {
      retryBtn.focus();
    } else {
      const stateText = container.querySelector<HTMLElement>('.pp-state-text');
      stateText?.setAttribute('tabindex', '-1');
      stateText?.focus();
    }
  }
}

let disposeDetail: (() => void) | undefined;

export function mountMenuScreen(container: HTMLElement): void {
  disposeDetail?.();
  disposeDetail = undefined;
  activeLoad?.abort();
  menuToken = null;
  liveTrackingOn = false;
  void suspendLiveTracking();
  disposeObserver();
  activeCategoryId = null;
  openerDishId = null;
  searchQuery = null;
  activeRefresher?.stop();
  activeRefresher = null;

  let savedScroll = 0;
  let currentMenu: Menu | null = null;
  let isLoading = false;
  let retryCount = 0;
  // Which view is showing, so a swap redraws only the list and never an open dish detail.
  let view: 'menu' | 'detail' = 'menu';

  const restoreOpenerFocus = () => {
    if (!openerDishId) return;
    const opener = Array.from(
      container.querySelectorAll<HTMLElement>('.pp-category:not([hidden]) .pp-card__open'),
    ).find((el) => el.dataset.openDishId === openerDishId);
    if (opener) opener.focus({ preventScroll: true });
    else focusAfterRetry(container, true);
  };

  const showMenu = () => {
    if (!currentMenu) return;
    disposeDetail?.();
    disposeDetail = undefined;
    view = 'menu';
    renderMenu(container, currentMenu, showDetail);
    window.scrollTo(0, savedScroll);
    restoreOpenerFocus();
  };

  const showDetail = (dish: CompleteDish) => {
    view = 'detail';
    savedScroll = window.scrollY;
    disposeObserver();
    disposeDetail?.();
    disposeDetail = renderDishDetail(container, dish, showMenu, currentMenu?.notice ?? null);
    window.scrollTo(0, 0);
  };

  // Called by the re-read timer when a new publication replaced the old one. The swap is a single
  // assignment. The list is redrawn only if it is on screen; an open dish detail stays as it is
  // and going back shows the new menu.
  const swapMenu = (next: Menu) => {
    currentMenu = next;
    if (view !== 'menu') return;
    const scrollY = window.scrollY;
    const focused = document.activeElement;
    let selector: string | null = null;
    if (focused instanceof HTMLElement && container.contains(focused)) {
      if (focused.id) selector = `#${CSS.escape(focused.id)}`;
      else if (focused.dataset.openDishId) {
        selector = `[data-open-dish-id="${CSS.escape(focused.dataset.openDishId)}"]`;
      } else if (focused.dataset.categoryId) {
        selector = `button[data-category-id="${CSS.escape(focused.dataset.categoryId)}"]`;
      } else {
        selector =
          ['.pp-search', '.pp-search-close', '.pp-search-empty__clear'].find((value) =>
            focused.matches(value),
          ) ?? 'h1';
      }
    }
    renderMenu(container, next, showDetail);
    if (selector) {
      const replacement = Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
        (element) => !element.closest('[hidden]'),
      );
      if (replacement && selector !== 'h1') {
        replacement.focus({ preventScroll: true });
      } else focusAfterRetry(container, true);
    }
    window.scrollTo(0, scrollY);
  };

  const loadMenu = () => {
    if (isLoading) return;
    isLoading = true;
    activeRefresher?.stop();
    activeRefresher = null;
    activeLoad?.abort();
    const controller = new AbortController();
    activeLoad = controller;
    const mode = menuMode(import.meta.env.VITE_MENU_SOURCE);
    fixtureMode = mode === 'fixture';
    renderLoading(container);

    // Re-reading scenario and delay from the query on each load allows retry recovery
    // in tests while maintaining identical behavior in production where the query is static.
    const scenario = scenarioFromQuery();
    const delayMs = delayFromQuery();

    // Fixture mode calls load() synchronously, exactly as before. Live mode loads the published
    // adapter on demand (dynamic import), so fixture builds do not carry or run it.
    const loading: Promise<MenuLoadResult> =
      mode === 'live'
        ? Promise.all([
            import('./published'),
            import('../tracking'),
            import('../tracking/delivery'),
          ]).then(([published, tracking, delivery]): Promise<MenuLoadResult> | MenuLoadResult => {
            const apiBase = import.meta.env.VITE_PUBLIC_API_URL;
            if (!apiBase) return { status: 'error' };
            const route = menuRouteFromPath(window.location.pathname);
            if (!route) return { status: 'unavailable' };
            const source = published.createPublishedMenuSource({
              apiBase,
              ...route,
              onDelivery: (info) => {
                if (controller.signal.aborted) return;
                menuToken = {
                  value: info.token,
                  expiresAt: info.expiresAt,
                  publicationRevisionId: info.publicationId,
                };
                // Every verified load, first or re-read, re-arms the timer for the new expiry.
                activeRefresher?.schedule(info.expiresAt);
                if (liveTrackingOn) return;
                liveTrackingOn = true;
                tracking.enableLiveTracking(
                  delivery.createLiveDeliver({
                    endpoint: `${apiBase.replace(/\/+$/, '')}/observations`,
                    fetch: (input, init) => fetch(input, init),
                    now: () => Date.now(),
                    token: () => menuToken,
                    canSend: () => !controller.signal.aborted && tracking.isLiveTracking(),
                  }),
                );
              },
            });
            activeRefresher = createMenuRefresher({
              source: { load: () => source.load(controller.signal) },
              getCurrent: () => currentMenu,
              onSwap: swapMenu,
              // The publication is gone. The menu on screen stays, but nothing more is delivered.
              onStop: () => {
                menuToken = null;
                controller.abort();
                liveTrackingOn = false;
                void tracking.suspendLiveTracking();
              },
            });
            return source.load(controller.signal);
          })
        : createFixtureMenuSource(scenario, delayMs === undefined ? {} : { delayMs }).load();

    const handleRetry = () => {
      if (isLoading) return;
      retryCount++;
      loadMenu();
    };

    loading
      .then((result: MenuLoadResult) => {
        if (controller.signal.aborted) return;
        isLoading = false;
        if (result.status !== 'ready') {
          renderFailure(container, result.status, handleRetry);
          if (retryCount > 0) {
            focusAfterRetry(container, false);
          }
          return;
        }
        currentMenu = result.menu;
        renderMenu(container, currentMenu, showDetail);
        if (retryCount > 0) {
          focusAfterRetry(container, true);
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        isLoading = false;
        renderFailure(container, 'error', handleRetry);
        if (retryCount > 0) {
          focusAfterRetry(container, false);
        }
      });
  };

  loadMenu();
}
