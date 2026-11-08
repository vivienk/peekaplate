import { renderDishDetail } from './dishDetail';
import type { FixtureScenario } from './fixtures';
import { createFixtureMenuSource, demoBundle } from './fixtures';
import { formatPrice } from './price';
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
const ALL_CATEGORY_ID = 'all';

let menuObserver: IntersectionObserver | null = null;
let activeCategoryId: string | null = null;
let openerDishId: string | null = null;

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

function renderLoading(container: HTMLElement): void {
  container.innerHTML = `
    <h1 class="pp-sr-only">${escapeHtml(demoBundle.restaurant.name)}</h1>
    <div class="pp-menu pp-menu--loading" role="status" aria-live="polite">
      <div class="pp-spinner" aria-hidden="true"></div>
      <p class="pp-loading-text">Loading menu…</p>
      <p class="pp-notice">${FIXTURE_LABEL}</p>
    </div>
  `;
}

// INTERIM: Failure heading uses demoBundle.restaurant.name because an error or 404 response
// carries no restaurant name. Design confirmation pending.
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
    <h1 class="pp-sr-only">${escapeHtml(demoBundle.restaurant.name)}</h1>
    <div class="pp-menu pp-menu--state" role="status" aria-live="polite">
      <p class="pp-state-text">${escapeHtml(messages[status] ?? 'We could not load the menu.')}</p>
      ${showRetry ? '<button class="pp-button" type="button" data-retry>Try again</button>' : ''}
      <p class="pp-notice">${FIXTURE_LABEL}</p>
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
        <button class="pp-search" type="button" aria-label="Search menu (not available yet)" disabled>
          <span aria-hidden="true">⌕</span>
        </button>
      </header>
      ${
        import.meta.env.VITE_OWNER_SIGN_IN_URL
          ? `<p class="pp-owner-link-wrap"><a class="pp-owner-link" href="${escapeHtml(import.meta.env.VITE_OWNER_SIGN_IN_URL)}" target="_blank" rel="noopener noreferrer">Restaurant owner? Sign in</a></p>`
          : ''
      }

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

      <p class="pp-end">End of menu</p>
      ${menu.notice ? `<p class="pp-notice">${escapeHtml(menu.notice)}</p>` : ''}
      <p class="pp-notice">Search, Save and Compare are not available yet.</p>
    </div>
  `;

  const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.pp-tab'));
  const categoryBlocks = Array.from(container.querySelectorAll<HTMLElement>('.pp-category'));

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.categoryId ?? null;
      activeCategoryId = target;
      tabButtons.forEach((item) => {
        item.classList.toggle('pp-tab--active', item === button);
        item.setAttribute('aria-pressed', String(item === button));
      });
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
      heading.focus();
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

export function mountMenuScreen(container: HTMLElement): void {
  disposeObserver();
  activeCategoryId = null;
  openerDishId = null;

  let savedScroll = 0;
  let currentMenu: Menu | null = null;
  let isLoading = false;
  let retryCount = 0;

  const restoreOpenerFocus = () => {
    if (!openerDishId) return;
    const opener = Array.from(
      container.querySelectorAll<HTMLElement>('.pp-category:not([hidden]) .pp-card__open'),
    ).find((el) => el.dataset.openDishId === openerDishId);
    opener?.focus({ preventScroll: true });
  };

  const showMenu = () => {
    if (!currentMenu) return;
    renderMenu(container, currentMenu, showDetail);
    window.scrollTo(0, savedScroll);
    restoreOpenerFocus();
  };

  const showDetail = (dish: CompleteDish) => {
    savedScroll = window.scrollY;
    disposeObserver();
    renderDishDetail(container, dish, showMenu, currentMenu?.notice ?? null);
    window.scrollTo(0, 0);
  };

  const loadMenu = () => {
    if (isLoading) return;
    isLoading = true;
    renderLoading(container);

    // Re-reading scenario and delay from the query on each load allows retry recovery
    // in tests while maintaining identical behavior in production where the query is static.
    const scenario = scenarioFromQuery();
    const delayMs = delayFromQuery();
    const source = createFixtureMenuSource(scenario, delayMs === undefined ? {} : { delayMs });

    const handleRetry = () => {
      if (isLoading) return;
      retryCount++;
      loadMenu();
    };

    source
      .load()
      .then((result: MenuLoadResult) => {
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
        isLoading = false;
        renderFailure(container, 'error', handleRetry);
        if (retryCount > 0) {
          focusAfterRetry(container, false);
        }
      });
  };

  loadMenu();
}
