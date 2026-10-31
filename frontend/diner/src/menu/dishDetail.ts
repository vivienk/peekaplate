import type { CompleteDish } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(dish: CompleteDish): string {
  return `${dish.price.currency} ${dish.price.amount}`.trim();
}

function allergenChips(dish: CompleteDish): string {
  if (dish.allergens.length === 0) return '';
  return dish.allergens
    .map(
      (value) => `
        <span class="pp-chip" aria-label="Contains ${escapeHtml(value)}">
          <span class="pp-chip__text">${escapeHtml(value)}</span>
        </span>
      `,
    )
    .join('');
}

function dietaryChips(dish: CompleteDish): string {
  if (dish.dietary.length === 0) return '';
  return dish.dietary
    .map(
      (value) => `
        <span class="pp-chip" aria-label="Dietary info: ${escapeHtml(value)}">
          <span class="pp-chip__text">${escapeHtml(value)}</span>
        </span>
      `,
    )
    .join('');
}

function ingredientTiles(dish: CompleteDish): string {
  return dish.ingredients
    .map(
      (ingredient) => `
        <div class="pp-ingredient" role="group" aria-label="${escapeHtml(ingredient.name)}">
          <p class="pp-ingredient__name">${escapeHtml(ingredient.name)}</p>
        </div>
      `,
    )
    .join('');
}

export function renderDishDetail(
  container: HTMLElement,
  dish: CompleteDish,
  onBack: () => void,
): void {
  const image = dish.images?.detail ?? dish.images?.card;
  const imageMarkup = image
    ? `<img class="pp-detail__image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" width="${image.width}" height="${image.height}" />`
    : `<div class="pp-detail__image pp-detail__image--missing" aria-hidden="true"></div>`;

  const hasAllergens = dish.allergens.length > 0;
  const hasDietary = dish.dietary.length > 0;
  const showAllergenSection = hasAllergens || hasDietary;

  container.innerHTML = `
    <div class="pp-detail">
      <header class="pp-detail__topbar">
        <button class="pp-detail__back" type="button" aria-label="Back to menu">←</button>
        <h1 class="pp-detail__title">Dish details</h1>
        <button class="pp-detail__save" type="button" aria-label="Save ${escapeHtml(dish.name)}" aria-pressed="false">
          <span aria-hidden="true">♡</span>
          <span>Save</span>
        </button>
      </header>

      <div class="pp-detail__image-wrap">
        ${imageMarkup}
      </div>

      <section class="pp-detail__section">
        <p class="pp-detail__category">${escapeHtml(dish.categoryName)}</p>
        <div class="pp-detail__name-row">
          <h2 class="pp-detail__name">${escapeHtml(dish.name)}</h2>
          <p class="pp-detail__price">${escapeHtml(money(dish))}</p>
        </div>
        <p class="pp-detail__description">${escapeHtml(dish.description)}</p>

        ${
          showAllergenSection
            ? `
              <div class="pp-allergen-section">
                <p class="pp-allergen-section__title">Allergens &amp; dietary info</p>
                ${
                  hasAllergens
                    ? `
                      <div class="pp-allergen-row">
                        <span class="pp-allergen-row__label">Contains</span>
                        <div class="pp-chip-group">${allergenChips(dish)}</div>
                      </div>
                    `
                    : ''
                }
                ${
                  hasDietary
                    ? `
                      <div class="pp-allergen-row">
                        <span class="pp-allergen-row__label">Dietary info</span>
                        <div class="pp-chip-group">${dietaryChips(dish)}</div>
                      </div>
                    `
                    : ''
                }
                <p class="pp-allergy-note">For allergy questions, please ask the restaurant staff.</p>
              </div>
            `
            : ''
        }

        <div class="pp-ingredients">
          <p class="pp-ingredients__title">Ingredients</p>
          <div class="pp-ingredient-list">${ingredientTiles(dish)}</div>
        </div>

        <div class="pp-detail__actions">
          <button class="pp-btn pp-btn--outlined" type="button">Compare</button>
        </div>
      </section>
    </div>
  `;

  const backButton = container.querySelector<HTMLButtonElement>('.pp-detail__back');
  backButton?.addEventListener('click', onBack);
}
