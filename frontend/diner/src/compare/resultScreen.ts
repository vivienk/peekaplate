// Compare result screen (S3-DIN-02.4, Figma "Compare result allergens"). Two dishes side by side,
// each with name, price, description, key ingredient names and the same "Contains" and
// "Dietary info" chips as dish detail, a divider between them, "View details" and "Replace" per
// dish, and "Back to Menu". The two dishes share one grid (subgrid rows), so each row lines up
// across them while every dish stays one readable group in DOM order. The screen itself sends
// nothing: the caller fires dish_compared when a valid comparison is displayed.
import { completeDishes } from '../menu/adapter';
import { allergenChips, dietaryChips } from '../menu/dishDetail';
import { formatPrice } from '../menu/price';
import type { CompleteDish, Menu } from '../menu/types';
import type { CompareSide, Comparison } from './comparison';

export const COMPARE_STAFF_LINE = 'For allergy questions, please ask the restaurant staff.';

export type CompareSideView = {
  side: CompareSide;
  dish: CompleteDish;
  ingredientNames: string[];
  hasAllergens: boolean;
  hasDietary: boolean;
};

// Both sides of a displayable comparison, first then other, or null when either dish is no longer
// complete on the menu or both sides are the same dish (a failed comparison shows no result).
export function compareView(
  menu: Menu,
  comparison: Comparison,
): [CompareSideView, CompareSideView] | null {
  const byId = new Map(completeDishes(menu).map((dish) => [dish.dishId, dish]));
  const first = byId.get(comparison.firstDishId);
  const other = byId.get(comparison.otherDishId);
  if (!first || !other || first.dishId === other.dishId) return null;
  const view = (side: CompareSide, dish: CompleteDish): CompareSideView => ({
    side,
    dish,
    ingredientNames: dish.ingredients.map((ingredient) => ingredient.name),
    hasAllergens: dish.allergens.length > 0,
    hasDietary: dish.dietary.length > 0,
  });
  return [view('first', first), view('other', other)];
}

export type CompareResultOptions = {
  menu: Menu;
  comparison: Comparison;
  onViewDetails(dish: CompleteDish, side: CompareSide): void;
  onReplace(side: CompareSide): void;
  onBackToMenu(): void;
  // The side whose button gets focus when the result is shown again (after Replace or detail).
  focus?: { side: CompareSide; control: 'view' | 'replace' } | undefined;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sideMarkup(view: CompareSideView): string {
  const { dish, side } = view;
  const name = escapeHtml(dish.name);
  const image = dish.images?.card;
  const imageMarkup = image
    ? `<img class="pp-compare__image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" width="${image.width}" height="${image.height}" />`
    : `<span class="pp-compare__image pp-card__image--missing" aria-hidden="true"></span>`;
  return `
    <article class="pp-compare__dish pp-compare__dish--${side}" data-side="${side}" data-dish-id="${escapeHtml(dish.dishId)}" aria-labelledby="pp-compare-name-${side}">
      <div class="pp-compare__media">${imageMarkup}</div>
      <h2 class="pp-compare__name" id="pp-compare-name-${side}">${name}</h2>
      <p class="pp-compare__price">${escapeHtml(formatPrice(dish.price))}</p>
      <p class="pp-compare__description">${escapeHtml(dish.description)}</p>
      <div class="pp-compare__ingredients">
        <p class="pp-compare__label">Key ingredients</p>
        <p class="pp-compare__ingredient-names">${view.ingredientNames.map(escapeHtml).join(', ')}</p>
      </div>
      <div class="pp-compare__group pp-compare__contains">
        ${
          view.hasAllergens
            ? `<p class="pp-compare__label">Contains</p><div class="pp-chip-group">${allergenChips(dish)}</div>`
            : ''
        }
      </div>
      <div class="pp-compare__group pp-compare__dietary">
        ${
          view.hasDietary
            ? `<p class="pp-compare__label">Dietary info</p><div class="pp-chip-group">${dietaryChips(dish)}</div>`
            : ''
        }
      </div>
      <div class="pp-compare__actions">
        <button class="pp-btn pp-btn--outlined pp-compare__view" type="button" aria-label="View details of ${name}">View details</button>
        <button class="pp-btn pp-btn--outlined pp-compare__replace" type="button" aria-label="Replace ${name}">Replace</button>
      </div>
    </article>
  `;
}

// Renders the result for a displayable comparison and returns true, or returns false without
// touching the container when compareView() says the comparison cannot be shown.
export function renderCompareResult(
  container: HTMLElement,
  options: CompareResultOptions,
): boolean {
  const { menu, comparison, onViewDetails, onReplace, onBackToMenu, focus } = options;
  const view = compareView(menu, comparison);
  if (!view) return false;

  container.innerHTML = `
    <div class="pp-compare">
      <header class="pp-detail__topbar pp-compare__topbar">
        <button class="pp-detail__back pp-compare__close" type="button" aria-label="Close compare">×</button>
        <h1 class="pp-detail__title" tabindex="-1">Compare</h1>
        <span class="pp-picker__spacer" aria-hidden="true"></span>
      </header>
      ${menu.notice ? `<p class="pp-notice">${escapeHtml(menu.notice)}</p>` : ''}

      <div class="pp-compare__grid">
        ${sideMarkup(view[0])}
        <div class="pp-compare__divider" aria-hidden="true"></div>
        ${sideMarkup(view[1])}
      </div>
      <p class="pp-allergy-note pp-compare__staff">${COMPARE_STAFF_LINE}</p>

      <div class="pp-picker__footer pp-compare__footer">
        <button class="pp-btn pp-btn--primary pp-compare__back" type="button">Back to Menu</button>
        <p class="pp-notice">Save is not available yet.</p>
      </div>
    </div>
  `;

  container
    .querySelector<HTMLButtonElement>('.pp-compare__close')
    ?.addEventListener('click', onBackToMenu);
  container
    .querySelector<HTMLButtonElement>('.pp-compare__back')
    ?.addEventListener('click', onBackToMenu);
  container.querySelector<HTMLElement>('.pp-compare')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onBackToMenu();
    }
  });
  for (const sideView of view) {
    const article = container.querySelector<HTMLElement>(
      `.pp-compare__dish[data-side="${sideView.side}"]`,
    );
    article
      ?.querySelector<HTMLButtonElement>('.pp-compare__view')
      ?.addEventListener('click', () => onViewDetails(sideView.dish, sideView.side));
    article
      ?.querySelector<HTMLButtonElement>('.pp-compare__replace')
      ?.addEventListener('click', () => onReplace(sideView.side));
  }

  const target = focus
    ? container.querySelector<HTMLElement>(
        `.pp-compare__dish[data-side="${focus.side}"] .pp-compare__${focus.control}`,
      )
    : container.querySelector<HTMLElement>('.pp-compare .pp-detail__title');
  target?.focus();
  return true;
}
