// Compare picker screen (S3-DIN-02.3, Figma "Compare Dish"). Compare on a dish detail opens it with
// that dish as "Keeping"; the diner selects one other dish (orange border and check), optionally
// after searching. Options come from pickerOptions(), so search reuses the shared menu rules and
// incomplete or already-shown dishes are never offered. Opening, searching, selecting and closing
// make no request, fire no event and never store, log or put the query in the URL.
import { completeDishes } from '../menu/adapter';
import { formatPrice } from '../menu/price';
import { SEARCH_STAFF_LINE, searchEmptyMarkup } from '../menu/searchView';
import type { CompleteDish, Menu } from '../menu/types';
import { type PickerExclusions, pickerOptions, selectOption } from './picker';

export type PickerViewState = {
  options: CompleteDish[];
  // No other complete dish exists on the menu, whatever the query.
  noOptions: boolean;
  // A query is typed and matches none of the options.
  noResults: boolean;
  allergyNotice: boolean;
  // Text for the polite live region; empty while no query is typed.
  announcement: string;
};

export function pickerViewState(
  menu: Menu,
  exclude: PickerExclusions,
  query: string,
): PickerViewState {
  const byId = new Map(completeDishes(menu).map((dish) => [dish.dishId, dish]));
  const toDishes = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const dish = byId.get(id);
      return dish ? [dish] : [];
    });
  const noOptions = pickerOptions(menu, exclude).dishIds.length === 0;
  const result = pickerOptions(menu, exclude, query);
  const options = toDishes(result.dishIds);
  const searching = query.trim() !== '';
  return {
    options,
    noOptions,
    noResults: !noOptions && searching && options.length === 0,
    allergyNotice: result.allergyNotice,
    announcement: !searching
      ? ''
      : options.length === 0
        ? 'No dishes found'
        : `${options.length} ${options.length === 1 ? 'dish' : 'dishes'} found`,
  };
}

export type ComparePickerOptions = {
  menu: Menu;
  // The dish Compare started from, shown as "Keeping".
  keptDish: CompleteDish;
  // Dishes that cannot be picked: the kept dish, or both shown dishes when replacing (DIN-02.4).
  exclude?: PickerExclusions;
  onClose(): void;
  // Called with the selected dish. Until the Compare result screen (DIN-02.4) passes it, the
  // Compare button stays disabled and says so.
  onConfirm?: (pickedDishId: string) => void;
  // "Compare" when starting a comparison, "Replace Dish" when replacing one side (DIN-02.4).
  confirmLabel?: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function thumbMarkup(dish: CompleteDish, className: string): string {
  const image = dish.images?.card;
  return image
    ? `<img class="${className}" src="${escapeHtml(image.url)}" alt="" width="${image.width}" height="${image.height}" loading="lazy" />`
    : `<span class="${className} pp-card__image--missing" aria-hidden="true"></span>`;
}

function optionMarkup(dish: CompleteDish, selected: boolean): string {
  const name = escapeHtml(dish.name);
  return `
    <article class="pp-card pp-picker__option${selected ? ' pp-card--selected' : ''}" data-dish-id="${escapeHtml(dish.dishId)}">
      <span class="pp-picker__check" aria-hidden="true">✓</span>
      <div class="pp-card__media">${thumbMarkup(dish, 'pp-card__image')}</div>
      <div class="pp-card__body">
        <p class="pp-card__category">${escapeHtml(dish.categoryName)}</p>
        <h2 class="pp-card__name"><button type="button" class="pp-card__open pp-picker__choose" data-pick-dish-id="${escapeHtml(dish.dishId)}" aria-pressed="${selected}" aria-label="Compare with ${name}"><span class="pp-card__name-text">${name}</span></button></h2>
        <p class="pp-card__price">${escapeHtml(formatPrice(dish.price))}</p>
        <button class="pp-card__save" type="button" aria-label="Save ${name} (not available yet)" disabled>
        <span aria-hidden="true">♡</span><span aria-hidden="true">Save</span>
        </button>
      </div>
    </article>
  `;
}

export function renderComparePicker(container: HTMLElement, options: ComparePickerOptions): void {
  const { menu, keptDish, onClose, onConfirm } = options;
  const confirmLabel = options.confirmLabel ?? 'Compare';
  const exclude = options.exclude ?? [keptDish.dishId];
  let query = '';
  let selectedId: string | null = null;
  const initial = pickerViewState(menu, exclude, query);

  container.innerHTML = `
    <div class="pp-picker">
      <header class="pp-detail__topbar pp-picker__topbar">
        <button class="pp-detail__back pp-picker__close" type="button" aria-label="Close compare">×</button>
        <h1 class="pp-detail__title" tabindex="-1">Compare Dish</h1>
        <span class="pp-picker__spacer" aria-hidden="true"></span>
      </header>

      <section class="pp-picker__keeping" aria-labelledby="pp-picker-keeping-label">
        <p class="pp-picker__label" id="pp-picker-keeping-label">Keeping</p>
        <div class="pp-picker__kept">
          ${thumbMarkup(keptDish, 'pp-picker__kept-image')}
          <p class="pp-picker__kept-name">${escapeHtml(keptDish.name)}</p>
        </div>
      </section>

      <section class="pp-picker__choose-section" aria-labelledby="pp-picker-choose-label">
        <p class="pp-picker__label" id="pp-picker-choose-label">Choose a dish to compare</p>
        ${
          initial.noOptions
            ? `<p class="pp-picker__none">There are no other dishes to compare on this menu yet.</p>`
            : `
              <p class="pp-picker__hint">Select another dish from the menu to compare side by side.</p>
              <form class="pp-search-bar pp-picker__search" role="search" aria-label="Search dishes to compare">
                <span class="pp-search-bar__icon" aria-hidden="true">⌕</span>
                <label class="pp-sr-only" for="pp-picker-search-input">Search dishes or ingredients</label>
                <input class="pp-search-input" id="pp-picker-search-input" type="search" placeholder="Search dishes" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" />
              </form>
              <p class="pp-search-staff" hidden>${SEARCH_STAFF_LINE}</p>
              <p class="pp-sr-only" id="pp-picker-status" role="status" aria-live="polite"></p>
              <div class="pp-category pp-picker__list" role="group" aria-labelledby="pp-picker-choose-label"></div>
              ${searchEmptyMarkup()}
            `
        }
      </section>

      <div class="pp-picker__footer">
        <button class="pp-btn pp-btn--primary pp-picker__confirm" type="button" disabled>${escapeHtml(confirmLabel)}</button>
        ${onConfirm ? '' : '<p class="pp-notice">Compare results are not available yet.</p>'}
      </div>
    </div>
  `;

  const title = container.querySelector<HTMLElement>('.pp-detail__title');
  container
    .querySelector<HTMLButtonElement>('.pp-picker__close')
    ?.addEventListener('click', onClose);
  const confirm = container.querySelector<HTMLButtonElement>('.pp-picker__confirm');
  confirm?.addEventListener('click', () => {
    if (selectedId && onConfirm) onConfirm(selectedId);
  });
  container.querySelector<HTMLElement>('.pp-picker')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  });
  title?.focus();

  const form = container.querySelector<HTMLFormElement>('.pp-picker__search');
  const input = container.querySelector<HTMLInputElement>('#pp-picker-search-input');
  const list = container.querySelector<HTMLElement>('.pp-picker__list');
  const staff = container.querySelector<HTMLElement>('.pp-search-staff');
  const status = container.querySelector<HTMLElement>('#pp-picker-status');
  const empty = container.querySelector<HTMLElement>('.pp-search-empty');
  const clear = container.querySelector<HTMLButtonElement>('.pp-search-empty__clear');
  if (!form || !input || !list || !staff || !status || !empty || !clear) return;

  const updateConfirm = () => {
    if (confirm) confirm.disabled = selectedId === null || !onConfirm;
  };

  const renderOptions = () => {
    const state = pickerViewState(menu, exclude, query);
    list.innerHTML = state.options
      .map((dish) => optionMarkup(dish, dish.dishId === selectedId))
      .join('');
    list.hidden = state.options.length === 0;
    empty.hidden = !state.noResults;
    staff.hidden = !state.allergyNotice;
    status.textContent = state.announcement;
  };

  const select = (dishId: string) => {
    selectedId = selectOption(menu, exclude, selectedId, dishId);
    for (const card of Array.from(list.querySelectorAll<HTMLElement>('.pp-picker__option'))) {
      const selected = card.dataset.dishId === selectedId;
      card.classList.toggle('pp-card--selected', selected);
      card
        .querySelector<HTMLButtonElement>('.pp-picker__choose')
        ?.setAttribute('aria-pressed', String(selected));
    }
    updateConfirm();
  };

  // One listener for the whole list, since search re-renders the cards. The heart is ignored.
  list.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('.pp-card__save')) return;
    const card = target.closest<HTMLElement>('.pp-picker__option');
    if (card?.dataset.dishId) select(card.dataset.dishId);
  });

  input.addEventListener('input', () => {
    query = input.value;
    renderOptions();
  });

  // Enter only closes the on-screen keyboard; a submitted form would reload the page.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    input.blur();
  });

  // Escape in a search with text clears it first; an empty search lets Escape close the picker.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && input.value !== '') {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      query = '';
      renderOptions();
    }
  });

  clear.addEventListener('click', () => {
    input.value = '';
    query = '';
    renderOptions();
    input.focus();
  });

  renderOptions();
  updateConfirm();
}
