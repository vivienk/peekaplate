// Menu search screen (S3-DIN-01.4, Figma "Search State"). The search icon opens a search bar under
// the header; matching dishes stay as the normal menu cards (the rest are hidden), with a
// "No Result Found" state and the staff allergy line from searchMenu(). Everything runs on the menu
// already loaded: no request, no tracking call, and the query is never stored, logged or put in the
// URL.
import { UI_ICONS } from './icons';
import { searchMenu } from './search';
import type { Menu } from './types';

export const SEARCH_ALL_CATEGORY_ID = 'all';
export const SEARCH_STAFF_LINE = 'For allergy questions, please ask the restaurant staff.';

export type SearchViewState = {
  // False for an empty or whitespace query: the menu shows unfiltered.
  active: boolean;
  // Complete dishes to show, in any category; null when search is not active.
  matches: ReadonlySet<string> | null;
  // Matches in the selected category block ("All" covers every category).
  visibleCount: number;
  noResults: boolean;
  allergyNotice: boolean;
  // Text for the polite live region, so screen readers hear the result count.
  announcement: string;
};

const INACTIVE: SearchViewState = {
  active: false,
  matches: null,
  visibleCount: 0,
  noResults: false,
  allergyNotice: false,
  announcement: '',
};

export function searchViewState(menu: Menu, query: string, categoryId: string): SearchViewState {
  if (query.trim() === '') return INACTIVE;
  const { dishIds, allergyNotice } = searchMenu(menu, query);
  const matches = new Set(dishIds);
  const inBlock =
    categoryId === SEARCH_ALL_CATEGORY_ID
      ? dishIds.length
      : (menu.categories
          .find((category) => category.categoryId === categoryId)
          ?.dishes.filter((dish) => dish.kind === 'complete' && matches.has(dish.dishId)).length ??
        0);
  return {
    active: true,
    matches,
    visibleCount: inBlock,
    noResults: inBlock === 0,
    allergyNotice,
    announcement:
      inBlock === 0 ? 'No dishes found' : `${inBlock} ${inBlock === 1 ? 'dish' : 'dishes'} found`,
  };
}

// The bar sits between the header and the category tabs, hidden until the icon opens it.
export function searchPanelMarkup(): string {
  return `
    <div class="pp-search-panel" id="pp-search-panel" hidden>
      <form class="pp-search-bar" role="search" aria-label="Menu search">
        <span class="pp-search-bar__icon" aria-hidden="true">⌕</span>
        <label class="pp-sr-only" for="pp-search-input">Search dishes or ingredients</label>
        <input class="pp-search-input" id="pp-search-input" type="search" placeholder="Search dishes or ingredients" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" />
        <button class="pp-search-close" type="button" aria-label="Close search"><img class="pp-search-close__icon" src="${UI_ICONS.close}" alt="" aria-hidden="true" width="16" height="16" /></button>
      </form>
      <p class="pp-search-staff" hidden>${SEARCH_STAFF_LINE}</p>
      <p class="pp-sr-only" id="pp-search-status" role="status" aria-live="polite"></p>
    </div>
  `;
}

export function searchEmptyMarkup(): string {
  return `
    <div class="pp-search-empty" hidden>
      <span class="pp-search-empty__icon" aria-hidden="true"></span>
      <h2 class="pp-search-empty__title">No Result Found</h2>
      <p class="pp-search-empty__text">Try a different dish name or ingredient.</p>
      <button class="pp-btn pp-btn--primary pp-search-empty__clear" type="button">Clear search</button>
    </div>
  `;
}

export type MenuSearchBinding = {
  // Re-applies the current query, e.g. after a category tab changes.
  refresh(): void;
};

export type MenuSearchOptions = {
  menu: Menu;
  // The open query; null when the bar is closed. Kept by the caller so a return from dish detail
  // restores the same results.
  query: string | null;
  onQueryChange(query: string | null): void;
  activeCategoryId(): string;
  // Search starts from every category, like the "All" tab in the design.
  selectAllCategories(): void;
};

// Wires the bar rendered by searchPanelMarkup() and searchEmptyMarkup() inside `container`.
export function bindMenuSearch(
  container: HTMLElement,
  options: MenuSearchOptions,
): MenuSearchBinding {
  const toggle = container.querySelector<HTMLButtonElement>('.pp-search');
  const panel = container.querySelector<HTMLElement>('.pp-search-panel');
  const form = container.querySelector<HTMLFormElement>('.pp-search-bar');
  const input = container.querySelector<HTMLInputElement>('.pp-search-input');
  const close = container.querySelector<HTMLButtonElement>('.pp-search-close');
  const staff = container.querySelector<HTMLElement>('.pp-search-staff');
  const status = container.querySelector<HTMLElement>('#pp-search-status');
  const empty = container.querySelector<HTMLElement>('.pp-search-empty');
  const clear = container.querySelector<HTMLButtonElement>('.pp-search-empty__clear');
  if (!toggle || !panel || !form || !input || !close || !staff || !status || !empty || !clear) {
    return { refresh() {} };
  }
  const cards = Array.from(container.querySelectorAll<HTMLElement>('.pp-category .pp-card'));
  let searching = false;

  const apply = () => {
    const state = searchViewState(options.menu, input.value, options.activeCategoryId());
    searching = state.active;
    for (const card of cards) {
      const dishId = card.dataset.dishId;
      // Placeholder cards have no searchable fields, so they never show as results.
      card.hidden = state.matches !== null && !(dishId && state.matches.has(dishId));
    }
    empty.hidden = !state.noResults;
    staff.hidden = !state.allergyNotice;
    status.textContent = state.announcement;
  };

  const open = (query: string) => {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    input.value = query;
    options.onQueryChange(query);
    apply();
  };

  const closeSearch = () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    input.value = '';
    options.onQueryChange(null);
    apply();
    toggle.focus();
  };

  toggle.addEventListener('click', () => {
    if (panel.hidden) {
      open('');
      input.focus();
    } else {
      closeSearch();
    }
  });

  input.addEventListener('input', () => {
    // A new search starts on "All"; a category picked while searching then narrows the results.
    if (!searching && input.value.trim() !== '') options.selectAllCategories();
    options.onQueryChange(input.value);
    apply();
  });

  // Enter only closes the on-screen keyboard; a submitted form would reload the page.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    input.blur();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  });

  close.addEventListener('click', closeSearch);

  clear.addEventListener('click', () => {
    input.value = '';
    options.onQueryChange('');
    apply();
    input.focus();
  });

  if (options.query !== null) open(options.query);

  return { refresh: apply };
}
