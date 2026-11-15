// Compare result screen (S3-DIN-02.4, Figma "Compare result allergens"). A header with both
// dishes (photo, name, price), then bordered sections (Description; Key ingredients with "View
// details" and a text-style "Replace" at its foot; Dietary & Allergen Info) that each show the two
// dishes side by side with a divider, so every row lines up. "Back to Menu" leaves Compare. The screen itself sends nothing: the caller fires dish_compared
// when a valid comparison is displayed.
import { completeDishes } from '../menu/adapter';
import { allergenIcon, dietaryIcon } from '../menu/icons';
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

function headerCell(view: CompareSideView): string {
  const { dish, side } = view;
  const image = dish.images?.card;
  const imageMarkup = image
    ? `<img class="pp-compare__image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" width="${image.width}" height="${image.height}" />`
    : `<span class="pp-compare__image pp-card__image--missing" aria-hidden="true"></span>`;
  return `
    <div class="pp-compare__cell pp-compare__dish" data-side="${side}" data-dish-id="${escapeHtml(dish.dishId)}">
      <div class="pp-compare__media">${imageMarkup}</div>
      <h2 class="pp-compare__name" id="pp-compare-name-${side}">${escapeHtml(dish.name)}</h2>
      <p class="pp-compare__price">${escapeHtml(formatPrice(dish.price))}</p>
    </div>
  `;
}

// One bordered section (Figma comparison grouping): a heading, then both dishes side by side with
// the divider between them. Each cell starts with the dish name for screen readers, so reading the
// section in order never leaves it unclear which dish a value belongs to.
function sectionMarkup(
  key: string,
  title: string,
  views: readonly CompareSideView[],
  cell: (view: CompareSideView) => string,
  extra = '',
): string {
  const cells = views
    .map(
      (view) => `
        <div class="pp-compare__cell" data-side="${view.side}">
          <span class="pp-sr-only">${escapeHtml(view.dish.name)}: </span>${cell(view)}
        </div>
      `,
    )
    .join('<div class="pp-compare__divider" aria-hidden="true"></div>');
  return `
    <section class="pp-compare__section pp-compare__section--${key}" aria-labelledby="pp-compare-${key}">
      <h3 class="pp-compare__label" id="pp-compare-${key}">${title}</h3>
      <div class="pp-compare__pair">${cells}</div>${extra}
    </section>
  `;
}

// Figma "Allergens-dietary-info-icons": allergens, then dietary labels, as icons. Each icon carries
// its full meaning for screen readers and as a tooltip ("Contains Wheat", "Vegan"); a value with no
// approved icon falls back to its text label, so nothing is ever dropped. A dish with nothing
// listed says "None listed" (Azoz review #12): never "allergen-free", which the data cannot promise.
function dietaryAllergenCell(dish: CompleteDish): string {
  const items = [
    ...dish.allergens.map((value) => ({
      icon: allergenIcon(value),
      label: `Contains ${value}`,
      text: value,
    })),
    ...dish.dietary.map((value) => ({ icon: dietaryIcon(value), label: value, text: value })),
  ];
  if (items.length === 0) return '<p class="pp-compare__none">None listed</p>';
  return `<ul class="pp-compare__icons">${items
    .map(({ icon, label, text }) =>
      icon
        ? `<li class="pp-compare__icon" title="${escapeHtml(label)}"><img src="${escapeHtml(icon)}" alt="${escapeHtml(label)}" width="24" height="24" /></li>`
        : `<li class="pp-chip pp-compare__icon-text"><span class="pp-sr-only">${escapeHtml(label)}</span><span class="pp-chip__text" aria-hidden="true">${escapeHtml(text)}</span></li>`,
    )
    .join('')}</ul>`;
}

function actionsCell(view: CompareSideView): string {
  const name = escapeHtml(view.dish.name);
  return `
    <div class="pp-compare__cell pp-compare__actions" data-side="${view.side}">
      <button class="pp-btn pp-btn--outlined pp-compare__view" type="button" aria-label="View details of ${name}">View details <span aria-hidden="true">→</span></button>
      <button class="pp-compare__replace" type="button" aria-label="Replace ${name}">Replace</button>
    </div>
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

      <div class="pp-compare__pair pp-compare__header">
        ${headerCell(view[0])}
        <div class="pp-compare__divider" aria-hidden="true"></div>
        ${headerCell(view[1])}
      </div>

      ${sectionMarkup('description', 'Description', view, (v) => `<p class="pp-compare__description">${escapeHtml(v.dish.description)}</p>`)}
      ${sectionMarkup(
        'ingredients',
        'Key ingredients',
        view,
        (v) =>
          `<p class="pp-compare__ingredient-names">${v.ingredientNames.map(escapeHtml).join(', ')}</p>`,
        // Figma places View details / Replace at the foot of the Key ingredients section.
        `<div class="pp-compare__pair pp-compare__action-row">
          ${actionsCell(view[0])}
          <div class="pp-compare__divider" aria-hidden="true"></div>
          ${actionsCell(view[1])}
        </div>`,
      )}
      ${sectionMarkup('dietary', 'Dietary &amp; Allergen Info', view, (v) => dietaryAllergenCell(v.dish))}

      <p class="pp-allergy-note pp-compare__staff">${COMPARE_STAFF_LINE}</p>

      <div class="pp-compare__footer">
        <button class="pp-btn pp-btn--primary pp-compare__back" type="button">Back to Menu</button>
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
    const actions = container.querySelector<HTMLElement>(
      `.pp-compare__actions[data-side="${sideView.side}"]`,
    );
    actions
      ?.querySelector<HTMLButtonElement>('.pp-compare__view')
      ?.addEventListener('click', () => onViewDetails(sideView.dish, sideView.side));
    actions
      ?.querySelector<HTMLButtonElement>('.pp-compare__replace')
      ?.addEventListener('click', () => onReplace(sideView.side));
  }

  const target = focus
    ? container.querySelector<HTMLElement>(
        `.pp-compare__actions[data-side="${focus.side}"] .pp-compare__${focus.control}`,
      )
    : container.querySelector<HTMLElement>('.pp-compare .pp-detail__title');
  target?.focus();
  return true;
}
