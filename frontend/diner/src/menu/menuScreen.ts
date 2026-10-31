import { newExposureId, newOpeningId, startOpeningClock, track } from '../tracking';
import { renderDishDetail } from './dishDetail';
import { createMenuViewedTrigger, type DetailSource, trackDishDetailOpened } from './events';
import type { FixtureScenario } from './fixtures';
import { createFixtureMenuSource, demoBundle } from './fixtures';
import type { CompleteDish, Menu, MenuLoadResult } from './types';

export function entrySourceFromSearch(search: string): 'qr' | 'direct_link' | 'unknown' {
  const src = new URLSearchParams(search).get('src');
  if (src === 'qr') return 'qr';
  if (src === null) return 'direct_link';
  return 'unknown';
}
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

function money(dish: CompleteDish): string {
  return `${dish.price.currency} ${dish.price.amount}`.trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLoading(container: HTMLElement): void {
  container.innerHTML = `
    <h1 class="pp-sr-only">${escapeHtml(demoBundle.restaurant.name)}</h1>
    <div class="pp-menu pp-menu--loading" role="status" aria-live="polite">
      <div class="pp-spinner" aria-hidden="true"></div>
      <p class="pp-loading-text">Loading menu…</p>
    </div>
  `;
}

function renderFailure(container: HTMLElement, status: MenuLoadResult['status']): void {
  const messages: Record<string, string> = {
    empty: 'No dishes are available right now.',
    unavailable: 'This menu is unavailable right now.',
    error: 'We could not load the menu. Please try again.',
    offline: 'You appear to be offline. Please check your connection.',
  };
  container.innerHTML = `
    <h1 class="pp-sr-only">${escapeHtml(demoBundle.restaurant.name)}</h1>
    <div class="pp-menu pp-menu--state" role="status" aria-live="polite">
      <p class="pp-state-text">${escapeHtml(messages[status] ?? 'We could not load the menu.')}</p>
    </div>
  `;
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
        <h2 class="pp-card__name"><button type="button" class="pp-card__open" data-open-dish-id="${escapeHtml(dish.dishId)}" aria-label="Open ${escapeHtml(dish.name)}">${escapeHtml(dish.name)}</button></h2>
        <p class="pp-card__price">${escapeHtml(money(dish))}</p>
        <p class="pp-card__description">${escapeHtml(dish.description)}</p>
      </div>
      <button class="pp-card__save" type="button" aria-label="Save ${escapeHtml(dish.name)}" aria-pressed="false">
        <span aria-hidden="true">♡</span>
      </button>
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
  const categories = menu.categories;
  const firstCategory = categories[0]?.categoryId ?? '';

  container.innerHTML = `
    <div class="pp-menu">
      <h1 class="pp-sr-only">${escapeHtml(menu.restaurant.name)}</h1>
      <header class="pp-header">
        <button class="pp-saved" type="button" aria-label="Saved dishes">
          <span class="pp-saved__icon" aria-hidden="true">♥</span>
          <span class="pp-saved__badge">2</span>
        </button>
        <div class="pp-logo">
          <span class="pp-logo__emblem" aria-hidden="true"></span>
          <span class="pp-logo__name">${escapeHtml(menu.restaurant.name)}</span>
        </div>
        <button class="pp-search" type="button" aria-label="Search menu">
          <span aria-hidden="true">⌕</span>
        </button>
      </header>
      ${
        import.meta.env.VITE_OWNER_SIGN_IN_URL
          ? `<p class="pp-owner-link-wrap"><a class="pp-owner-link" href="${escapeHtml(import.meta.env.VITE_OWNER_SIGN_IN_URL)}" target="_blank" rel="noopener noreferrer">Restaurant owner? Sign in</a></p>`
          : ''
      }

      <nav class="pp-tabs" aria-label="Menu categories">
        ${categories
          .map(
            (category, index) => `
              <button class="pp-tab${index === 0 ? ' pp-tab--active' : ''}" type="button" data-category-id="${escapeHtml(category.categoryId)}">
                ${escapeHtml(category.name)}
              </button>
            `,
          )
          .join('')}
      </nav>

      <section class="pp-dishes" aria-live="polite">
        ${categories
          .map((category) => {
            const cards = category.dishes
              .map((dish) =>
                dish.kind === 'complete' ? renderCard(dish) : renderPlaceholderCard(),
              )
              .join('');
            return `<div class="pp-category" data-category-id="${escapeHtml(category.categoryId)}" ${category.categoryId === firstCategory ? '' : 'hidden'}>${cards}</div>`;
          })
          .join('')}
      </section>

      <p class="pp-end">End of menu</p>
      ${menu.notice ? `<p class="pp-notice">${escapeHtml(menu.notice)}</p>` : ''}
    </div>
  `;

  const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.pp-tab'));
  const categoryBlocks = Array.from(container.querySelectorAll<HTMLElement>('.pp-category'));

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.categoryId;
      tabButtons.forEach((item) => item.classList.toggle('pp-tab--active', item === button));
      categoryBlocks.forEach((block) => {
        block.hidden = block.dataset.categoryId !== target;
      });
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
    cards.forEach((card) => observer.observe(card));
  } else {
    cards.forEach((card) => card.classList.add('pp-card--inview'));
  }

  const dishMap = new Map<string, CompleteDish>();
  menu.categories.forEach((category) => {
    category.dishes.forEach((dish) => {
      if (dish.kind === 'complete') dishMap.set(dish.dishId, dish);
    });
  });

  container.querySelectorAll<HTMLElement>('.pp-card[data-dish-id]').forEach((card) => {
    const dishId = card.dataset.dishId;
    const dish = dishId ? dishMap.get(dishId) : undefined;
    if (!dish) return;
    const openButton = card.querySelector<HTMLButtonElement>('.pp-card__open');
    card.style.cursor = 'pointer';
    card.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.pp-card__save')) return;
      if (target.closest('.pp-card__open')) return;
      onOpenDetail(dish);
    });
    openButton?.addEventListener('click', () => onOpenDetail(dish));
  });
}

export function mountMenuScreen(container: HTMLElement): void {
  renderLoading(container);

  const scenario = scenarioFromQuery();
  const delayMs = delayFromQuery();
  const source = createFixtureMenuSource(scenario, delayMs === undefined ? {} : { delayMs });

  let savedScroll = 0;
  let currentMenu: Menu | null = null;
  let openingClock: ReturnType<typeof startOpeningClock> | null = null;
  let detailActivityHandler: (() => void) | null = null;
  const exposureTimers = new Map<HTMLElement, number>();
  const exposureIds = new Map<string, string>();
  let exposureObserver: IntersectionObserver | null = null;
  const menuViewedTrigger = createMenuViewedTrigger();

  const entrySource = (): 'qr' | 'direct_link' | 'unknown' =>
    entrySourceFromSearch(window.location.search);

  const cleanupExposure = () => {
    exposureTimers.forEach((timer) => window.clearTimeout(timer));
    exposureTimers.clear();
    if (exposureObserver) {
      exposureObserver.disconnect();
      exposureObserver = null;
    }
  };

  const showMenu = () => {
    if (!currentMenu) return;
    if (detailActivityHandler) {
      container.removeEventListener('click', detailActivityHandler);
      container.removeEventListener('scroll', detailActivityHandler);
      container.removeEventListener('keydown', detailActivityHandler);
      container.removeEventListener('pointerdown', detailActivityHandler);
      detailActivityHandler = null;
    }
    if (openingClock) {
      openingClock.end();
      openingClock = null;
    }
    renderMenu(container, currentMenu, showDetail);
    window.scrollTo(0, savedScroll);
    setupExposureTracking(currentMenu);
  };

  const showDetail = (dish: CompleteDish) => {
    if (!currentMenu) return;
    savedScroll = window.scrollY;
    cleanupExposure();
    if (openingClock) {
      openingClock.end();
      openingClock = null;
    }
    renderDishDetail(container, dish, showMenu);
    window.scrollTo(0, 0);

    const opening: {
      source: 'menu_card';
      fromExposureId?: string;
      saveAvailable: false;
    } = {
      source: 'menu_card',
      saveAvailable: false,
    };
    const exposureId = exposureIds.get(dish.dishId);
    if (exposureId !== undefined) opening.fromExposureId = exposureId;

    const openingId = trackDishDetailOpened(currentMenu, dish, opening, track, newOpeningId);

    if (openingId) {
      openingClock = startOpeningClock(
        {
          publication_revision_id: currentMenu.publicationRevisionId,
          dish_id: dish.dishId,
          dish_revision_id: dish.dishRevisionId,
          opening_id: openingId,
        },
        { send: track },
      );

      if (detailActivityHandler) {
        container.removeEventListener('click', detailActivityHandler);
        container.removeEventListener('scroll', detailActivityHandler);
        container.removeEventListener('keydown', detailActivityHandler);
        container.removeEventListener('pointerdown', detailActivityHandler);
        detailActivityHandler = null;
      }

      const reportActivity = () => openingClock?.activity();
      detailActivityHandler = reportActivity;
      container.addEventListener('click', reportActivity);
      container.addEventListener('scroll', reportActivity);
      container.addEventListener('keydown', reportActivity);
      container.addEventListener('pointerdown', reportActivity);
    }
  };

  const setupExposureTracking = (menu: Menu) => {
    cleanupExposure();
    const complete = menu.categories.flatMap((category) =>
      category.dishes.filter((dish): dish is CompleteDish => dish.kind === 'complete'),
    );
    const positionByDish = new Map<string, number>();
    complete.forEach((dish, index) => positionByDish.set(dish.dishId, index + 1));

    exposureObserver = new IntersectionObserver(
      (entries) => {
        if (document.hidden) return;
        entries.forEach((entry) => {
          const card = entry.target as HTMLElement;
          const dishId = card.dataset.dishId;
          if (!dishId) return;
          const dish = complete.find((item) => item.dishId === dishId);
          if (!dish) return;

          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (!exposureTimers.has(card)) {
              const timer = window.setTimeout(() => {
                if (document.hidden) return;
                const exposureId = newExposureId();
                exposureIds.set(dishId, exposureId);
                try {
                  track('dish_viewed', {
                    publication_revision_id: menu.publicationRevisionId,
                    dish_id: dish.dishId,
                    dish_revision_id: dish.dishRevisionId,
                    exposure_id: exposureId,
                    surface: 'menu_list',
                    position: positionByDish.get(dishId) ?? 0,
                    exposure_basis: 'viewport_50pct_1s',
                  });
                } catch {
                  // Tracking must not break the menu.
                }
              }, 1000);
              exposureTimers.set(card, timer);
            }
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

    container.querySelectorAll<HTMLElement>('.pp-card[data-dish-id]').forEach((card) => {
      exposureObserver?.observe(card);
    });

    const onVisibilityChange = () => {
      if (document.hidden) {
        exposureTimers.forEach((timer) => window.clearTimeout(timer));
        exposureTimers.clear();
      } else {
        exposureObserver?.disconnect();
        container.querySelectorAll<HTMLElement>('.pp-card[data-dish-id]').forEach((card) => {
          exposureObserver?.observe(card);
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
  };

  void source.load().then((result: MenuLoadResult) => {
    if (result.status !== 'ready') {
      renderFailure(container, result.status);
      return;
    }
    currentMenu = result.menu;
    menuViewedTrigger(currentMenu, entrySource());
    renderMenu(container, currentMenu, showDetail);
    setupExposureTracking(currentMenu);
  });
}
