import { createSaveState, type SaveState } from '../save/save-state';
import { renderSavedScreen } from '../save/saved-screen';
import {
  bindDetailSave,
  bindMenuSave,
  isSavedRoute,
  SAVED_ROUTE,
  savedHeaderMarkup,
  saveHeartMarkup,
  toastAreaMarkup,
} from '../save/screens';
import {
  isLiveTracking,
  isTrackingAllowed,
  newExposureId,
  newOpeningId,
  onTrackingAllowedChange,
  startOpeningClock,
  suspendLiveTracking,
  track,
} from '../tracking';
import type { MenuToken } from '../tracking/delivery';
import { menuMode } from './config';
import { renderDishDetail } from './dishDetail';
import { createMenuViewedTrigger, type DetailOpening, trackDishDetailOpened } from './events';
import type { FixtureScenario } from './fixtures';
import { createFixtureMenuSource, demoBundle } from './fixtures';
import { formatPrice } from './price';
import { createMenuRefresher, type MenuRefresher } from './refresh';
import { resolveMenuRoute } from './route';
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
// Stops this mount's tracking (exposure timers, detail clock, listeners) when the screen mounts again.
let teardownTracking: (() => void) | null = null;

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
        ${saveHeartMarkup(dish, 'pp-card__save')}
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
        ${savedHeaderMarkup()}
        <div class="pp-logo">
          <span class="pp-logo__emblem" aria-hidden="true"></span>
          <span class="pp-logo__name">${escapeHtml(menu.restaurant.name)}</span>
        </div>
        <button class="pp-search" type="button" aria-label="Search menu" aria-expanded="false" aria-controls="pp-search-panel">
          <span aria-hidden="true">⌕</span>
        </button>
      </header>
      ${toastAreaMarkup()}
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
      <p class="pp-notice">Compare is not available yet.</p>
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

// Save must never break browsing: if attaching it fails, the screen still works without Save.
function attachSave(bind: () => () => void): () => void {
  try {
    return bind();
  } catch {
    return () => {};
  }
}

// Removes the previous mount's Saved-route listener, so remounting never navigates twice.
let stopRouting: () => void = () => {};

export function mountMenuScreen(container: HTMLElement): void {
  teardownTracking?.();
  teardownTracking = null;
  activeLoad?.abort();
  menuToken = null;
  liveTrackingOn = false;
  void suspendLiveTracking();
  disposeObserver();
  stopRouting();
  activeCategoryId = null;
  openerDishId = null;
  searchQuery = null;
  activeRefresher?.stop();
  activeRefresher = null;

  let savedScroll = 0;
  let currentMenu: Menu | null = null;
  // Shared by every screen, so the hearts, badge and Saved screen agree (S3-DIN-02).
  let saveState: SaveState | null = null;
  let view: 'menu' | 'detail' | 'saved' = 'menu';
  // Detaches the current screen's Save behaviour before the next screen renders.
  let leaveScreen: () => void = () => {};
  // True when this page added the Saved route to history, so leaving it can go back instead.
  let savedRouteAdded = false;
  let isLoading = false;
  let retryCount = 0;

  // Tracking state. IDs, timing and dispatch belong to the shared tracking layer.
  let openingClock: ReturnType<typeof startOpeningClock> | null = null;
  let stopActivityListeners: (() => void) | null = null;
  let exposureObserver: IntersectionObserver | null = null;
  let stopVisibilityListener: (() => void) | null = null;
  let stopConsentListener: (() => void) | null = null;
  let resumeDetailTracking: (() => void) | null = null;
  const exposureTimers = new Map<HTMLElement, number>();
  const exposureIds = new Map<string, string>();
  const menuViewedTrigger = createMenuViewedTrigger();
  // QR is out of scope (Nov 1), so this is always direct_link.
  const entrySource = 'direct_link' as const;
  const canTrackUi = () => fixtureMode || (isLiveTracking() && isTrackingAllowed());

  const cleanupExposure = () => {
    exposureTimers.forEach((timer) => window.clearTimeout(timer));
    exposureTimers.clear();
    exposureObserver?.disconnect();
    exposureObserver = null;
    stopVisibilityListener?.();
    stopVisibilityListener = null;
  };

  const stopDetailTracking = () => {
    stopActivityListeners?.();
    stopActivityListeners = null;
    if (openingClock) {
      openingClock.end(); // the merged clock sends the final active_ms checkpoint
      openingClock = null;
    }
  };

  teardownTracking = () => {
    stopConsentListener?.();
    stopDetailTracking();
    cleanupExposure();
  };

  const restoreOpenerFocus = () => {
    if (!openerDishId) return;
    const opener = Array.from(
      container.querySelectorAll<HTMLElement>('.pp-category:not([hidden]) .pp-card__open'),
    ).find((el) => el.dataset.openDishId === openerDishId);
    if (opener) opener.focus({ preventScroll: true });
    else focusAfterRetry(container, true);
  };

  // dish_viewed: at least 50% of the card visible for 1 s while the tab is visible.
  // The 50% dimming does not matter. The All tab and each category both render a card, but the
  // hidden copy (and search-hidden cards) never intersect, so only the visible copy counts.
  const setupExposureTracking = (menu: Menu) => {
    cleanupExposure();
    const complete = menu.categories.flatMap((category) =>
      category.dishes.filter((dish): dish is CompleteDish => dish.kind === 'complete'),
    );
    const dishById = new Map(complete.map((dish) => [dish.dishId, dish]));
    const positionByDish = new Map(complete.map((dish, index) => [dish.dishId, index + 1]));

    exposureObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const card = entry.target as HTMLElement;
          const dishId = card.dataset.dishId;
          const dish = dishId ? dishById.get(dishId) : undefined;
          if (!dishId || !dish) return;

          const qualifies =
            !document.hidden &&
            entry.isIntersecting &&
            entry.intersectionRatio >= 0.5 &&
            !card.closest('[hidden]');

          if (qualifies) {
            if (exposureTimers.has(card)) return;
            const timer = window.setTimeout(() => {
              if (!canTrackUi() || document.hidden || !card.isConnected || card.closest('[hidden]'))
                return;
              const exposureId = newExposureId();
              exposureIds.set(dishId, exposureId);
              // track() never throws. category_filter is left out until matrix 3.1 is confirmed.
              track('dish_viewed', {
                publication_revision_id: menu.publicationRevisionId,
                dish_id: dish.dishId,
                dish_revision_id: dish.dishRevisionId,
                exposure_id: exposureId,
                surface: 'menu_list',
                position: positionByDish.get(dishId) ?? 0,
                exposure_basis: 'viewport_50pct_1s',
              });
            }, 1000);
            exposureTimers.set(card, timer);
          } else {
            const timer = exposureTimers.get(card);
            if (timer !== undefined) {
              window.clearTimeout(timer);
              exposureTimers.delete(card);
            }
          }
        });
      },
      { threshold: [0, 0.5] },
    );

    const observeCards = () => {
      container.querySelectorAll<HTMLElement>('.pp-card[data-dish-id]').forEach((card) => {
        exposureObserver?.observe(card);
      });
    };
    observeCards();

    const onVisibilityChange = () => {
      if (document.hidden) {
        exposureTimers.forEach((timer) => window.clearTimeout(timer));
        exposureTimers.clear();
      } else {
        exposureObserver?.disconnect();
        observeCards();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    stopVisibilityListener = () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  };

  // Tracking setup must never break the menu.
  const startExposureTracking = (menu: Menu) => {
    if (!canTrackUi()) return;
    try {
      setupExposureTracking(menu);
    } catch {
      cleanupExposure();
    }
  };

  const switchScreen = (next: typeof view) => {
    if (view === 'menu') savedScroll = window.scrollY;
    leaveScreen();
    leaveScreen = () => {};
    disposeObserver();
    // Leaving a screen ends its tracking: exposure timers and the detail clock's final checkpoint.
    cleanupExposure();
    stopDetailTracking();
    resumeDetailTracking = null;
    view = next;
  };

  const showMenu = (focus: 'opener' | 'saved' = 'opener') => {
    if (!currentMenu || !saveState) return;
    const menu = currentMenu;
    switchScreen('menu');
    renderMenu(container, menu, (dish) => showDetail(dish, 'menu_card'));
    const state = saveState;
    leaveScreen = attachSave(() =>
      bindMenuSave(container, { saveState: state, menu, send: track, onOpenSaved: openSaved }),
    );
    window.scrollTo(0, savedScroll);
    if (focus === 'saved') container.querySelector<HTMLElement>('.pp-saved')?.focus();
    else restoreOpenerFocus();
    if (canTrackUi()) menuViewedTrigger(menu, entrySource);
    startExposureTracking(menu);
  };

  const showDetail = (dish: CompleteDish, from: 'menu_card' | 'saved_screen') => {
    if (!currentMenu || !saveState) return;
    const menu = currentMenu;
    switchScreen('detail');
    const fromSaved = from === 'saved_screen';
    renderDishDetail(
      container,
      dish,
      fromSaved ? () => showSaved() : () => showMenu(),
      menu.notice,
    );
    if (fromSaved) {
      container.querySelector('.pp-detail__back')?.setAttribute('aria-label', 'Back to Saved');
    }
    const state = saveState;
    leaveScreen = attachSave(() =>
      bindDetailSave(container, { saveState: state, menu, send: track }),
    );
    window.scrollTo(0, 0);

    // The Saved screen's own entry point (DIN-02.5), unchanged.
    if (fromSaved) {
      try {
        trackDishDetailOpened(menu, dish, {
          source: 'saved_screen',
          saveAvailable: state.isSaveAvailable(),
        });
      } catch {}
      return;
    }

    // Consent begins a fresh opening; time from a disallowed stretch is never reused.
    resumeDetailTracking = () => {
      if (!canTrackUi()) return;
      const exposureId = exposureIds.get(dish.dishId);
      const opening: DetailOpening = {
        source: 'menu_card',
        saveAvailable: state.isSaveAvailable(),
        ...(exposureId === undefined ? {} : { fromExposureId: exposureId }),
      };
      const openingId = trackDishDetailOpened(menu, dish, opening, track, newOpeningId);
      if (!openingId) return;
      openingClock = startOpeningClock(
        {
          publication_revision_id: menu.publicationRevisionId,
          dish_id: dish.dishId,
          dish_revision_id: dish.dishRevisionId,
          opening_id: openingId,
        },
        { send: track },
      );

      // The page scrolls, not the container, so scroll is listened for on window.
      const reportActivity = () => openingClock?.activity();
      container.addEventListener('click', reportActivity);
      container.addEventListener('keydown', reportActivity);
      container.addEventListener('pointerdown', reportActivity);
      window.addEventListener('scroll', reportActivity, { passive: true });
      stopActivityListeners = () => {
        container.removeEventListener('click', reportActivity);
        container.removeEventListener('keydown', reportActivity);
        container.removeEventListener('pointerdown', reportActivity);
        window.removeEventListener('scroll', reportActivity);
      };
    };
    resumeDetailTracking();
  };

  const showSaved = (recordView = true) => {
    if (!currentMenu || !saveState) return;
    const menu = currentMenu;
    switchScreen('saved');
    leaveScreen = renderSavedScreen(container, {
      saveState,
      menu,
      send: track,
      recordView,
      onOpenDish: (dish) => showDetail(dish, 'saved_screen'),
      onBack: leaveSaved,
    });
    window.scrollTo(0, 0);
    const title = container.querySelector<HTMLElement>('.pp-saved__title');
    title?.setAttribute('tabindex', '-1');
    title?.focus();
  };

  // The header heart: adds the Saved route, and the route change shows the screen.
  function openSaved() {
    if (isSavedRoute()) {
      showSaved();
      return;
    }
    savedRouteAdded = true;
    window.location.hash = SAVED_ROUTE;
  }

  // Back and "Browse menu". Going back in history keeps the browser's Back button in step; after a
  // reload on the Saved route there is nothing to go back to, so the route is replaced instead.
  function leaveSaved() {
    if (savedRouteAdded && isSavedRoute()) {
      savedRouteAdded = false;
      window.history.back();
      return;
    }
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    showMenu('saved');
  }

  // The browser's Back and Forward buttons, and links to the Saved route.
  const onRouteChange = () => {
    if (isSavedRoute()) {
      if (view !== 'saved') showSaved();
    } else if (view !== 'menu') {
      showMenu(view === 'saved' ? 'saved' : 'opener');
    }
  };
  window.addEventListener('hashchange', onRouteChange);
  stopRouting = () => window.removeEventListener('hashchange', onRouteChange);

  // Called by the re-read timer when a new publication replaced the old one. The swap is a single
  // assignment. The list is redrawn only if it is on screen; an open dish detail stays as it is
  // and going back shows the new menu.
  const swapMenu = (next: Menu) => {
    exposureIds.clear();
    currentMenu = next;
    // A new publication is a successful load: withdrawn saved dishes drop out (no event).
    saveState?.reconcile(next);
    if (view === 'saved') {
      const focused = document.activeElement;
      const dishId = focused?.closest<HTMLElement>('.pp-saved__item')?.dataset.dishId;
      const wasHeart = focused?.matches('.pp-saved__save');
      const scrollY = window.scrollY;
      showSaved(false);
      if (dishId) {
        const row = Array.from(container.querySelectorAll<HTMLElement>('.pp-saved__item')).find(
          (item) => item.dataset.dishId === dishId,
        );
        row
          ?.querySelector<HTMLElement>(wasHeart ? '.pp-saved__save' : '.pp-saved__open')
          ?.focus({ preventScroll: true });
      }
      window.scrollTo(0, scrollY);
      return;
    }
    // Only the list is redrawn. An open dish detail or Saved screen stays as it is, and going back
    // shows the new menu.
    if (view !== 'menu') return;
    const scrollY = window.scrollY;
    const focused = document.activeElement;
    let selector: string | null = null;
    if (focused instanceof HTMLElement && container.contains(focused)) {
      if (focused.id) selector = `#${CSS.escape(focused.id)}`;
      else if (focused.dataset.openDishId) {
        selector = `[data-open-dish-id="${CSS.escape(focused.dataset.openDishId)}"]`;
      } else if (focused.dataset.saveDishId) {
        selector = `[data-save-dish-id="${CSS.escape(focused.dataset.saveDishId)}"]`;
      } else if (focused.dataset.categoryId) {
        selector = `button[data-category-id="${CSS.escape(focused.dataset.categoryId)}"]`;
      } else {
        selector =
          ['.pp-saved', '.pp-search', '.pp-search-close', '.pp-search-empty__clear'].find((value) =>
            focused.matches(value),
          ) ?? 'h1';
      }
    }
    cleanupExposure();
    leaveScreen();
    leaveScreen = () => {};
    renderMenu(container, next, (dish) => showDetail(dish, 'menu_card'));
    const state = saveState;
    if (state) {
      leaveScreen = attachSave(() =>
        bindMenuSave(container, {
          saveState: state,
          menu: next,
          send: track,
          onOpenSaved: openSaved,
        }),
      );
    }
    if (selector) {
      const replacement = Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
        (element) => !element.closest('[hidden]'),
      );
      if (replacement && selector !== 'h1') {
        replacement.focus({ preventScroll: true });
      } else focusAfterRetry(container, true);
    }
    window.scrollTo(0, scrollY);
    if (canTrackUi()) menuViewedTrigger(next, entrySource);
    startExposureTracking(next);
  };

  let allowedBefore = isTrackingAllowed();
  stopConsentListener = onTrackingAllowedChange((allowed) => {
    if (allowed === allowedBefore) return;
    allowedBefore = allowed;
    if (fixtureMode) return;
    stopDetailTracking();
    cleanupExposure();
    exposureIds.clear();
    if (!canTrackUi()) return;
    if (view === 'menu' && currentMenu) {
      menuViewedTrigger(currentMenu, entrySource);
      startExposureTracking(currentMenu);
    } else if (view === 'detail') resumeDetailTracking?.();
  });

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
          ]).then(async ([published, tracking, delivery]): Promise<MenuLoadResult> => {
            const apiBase = import.meta.env.VITE_PUBLIC_API_URL;
            if (!apiBase) return { status: 'error' };
            const route = await resolveMenuRoute(window.location.pathname, {
              apiBase,
              signal: controller.signal,
            });
            controller.signal.throwIfAborted();
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
        // One Save state per visit; a retry after a failed load creates it then.
        saveState ??= createSaveState({ venueId: result.menu.venueId });
        // Only after a successful load: removes withdrawn dishes and enables saving.
        saveState.reconcile(result.menu);
        if (isSavedRoute()) showSaved();
        else showMenu();
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
