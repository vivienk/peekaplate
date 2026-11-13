import { saveHeartMarkup, toastAreaMarkup } from '../save/screens';
import { allergenIcon, dietaryIcon, ingredientIcon, UI_ICONS } from './icons';
import { bindPortionPreview } from './portionPreview';
import { formatPrice } from './price';
import type { CompleteDish } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function iconMarkup(src: string | null, className: string, size: number): string {
  if (!src) return '';
  return `<img class="${className}" src="${escapeHtml(src)}" alt="" aria-hidden="true" width="${size}" height="${size}" />`;
}
function allergenChips(dish: CompleteDish): string {
  if (dish.allergens.length === 0) return '';
  return dish.allergens
    .map(
      (value) => `
        <span class="pp-chip" aria-label="Contains ${escapeHtml(value)}">${iconMarkup(allergenIcon(value), 'pp-chip__icon', 16)}
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
        <span class="pp-chip" aria-label="Dietary info: ${escapeHtml(value)}">${iconMarkup(dietaryIcon(value), 'pp-chip__icon', 16)}
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
          ${iconMarkup(ingredientIcon(ingredient.name), 'pp-ingredient__icon', 32)}<p class="pp-ingredient__name">${escapeHtml(ingredient.name)}</p>
        </div>
      `,
    )
    .join('');
}

export function renderDishDetail(
  container: HTMLElement,
  dish: CompleteDish,
  onBack: () => void,
  notice: string | null = null,
): () => void {
  const image = dish.images?.detail ?? dish.images?.card;
  const imageMarkup = image
    ? `<img class="pp-detail__image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" width="${image.width}" height="${image.height}" />`
    : `<div class="pp-detail__image pp-detail__image--missing" aria-hidden="true"></div>`;

  const hasAllergens = dish.allergens.length > 0;
  const hasDietary = dish.dietary.length > 0;
  const allergyNote = `<p class="pp-allergy-note">For allergy questions, please ask the restaurant staff.</p>`;

  container.innerHTML = `
    <div class="pp-detail">
      <header class="pp-detail__topbar">
        <button class="pp-back pp-detail__back" type="button" aria-label="Back to menu"><img class="pp-detail__back-icon" src="${UI_ICONS.back}" alt="" aria-hidden="true" width="16" height="16" /></button>
        <h1 class="pp-detail__title" tabindex="-1">Dish details</h1>
        ${saveHeartMarkup(dish, 'pp-detail__save')}
      </header>
      ${toastAreaMarkup()}
      ${notice ? `<p class="pp-notice">${escapeHtml(notice)}</p>` : ''}

      <div class="pp-detail__image-wrap">
        ${imageMarkup}
      </div>

      <p class="pp-portion__status pp-notice" role="status" hidden></p>
      <section class="pp-detail__section">
        <div class="pp-detail__text">
          <p class="pp-detail__category">${escapeHtml(dish.categoryName)}</p>
          <div class="pp-detail__name-row">
            <h2 class="pp-detail__name">${escapeHtml(dish.name)}</h2>
            <p class="pp-detail__price">${escapeHtml(formatPrice(dish.price))}</p>
          </div>
          <p class="pp-detail__description">${escapeHtml(dish.description)}</p>
        </div>

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
              : `
                <div class="pp-allergen-row">
                  <span class="pp-allergen-row__label">Contains</span>
                  ${allergyNote}
                </div>
              `
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
          ${hasAllergens ? allergyNote : ''}
        </div>

        <div class="pp-ingredients">
          <p class="pp-ingredients__title">Ingredients</p>
          <div class="pp-ingredient-list">${ingredientTiles(dish)}</div>
        </div>

        <div class="pp-detail__actions">
          <button class="pp-btn pp-btn--primary pp-detail__portion" type="button">View Portion</button>
          <button class="pp-btn pp-btn--outlined" type="button" disabled>Compare <span aria-hidden="true">→</span></button>
        </div>
        <p class="pp-notice">Compare is not available yet.</p>
      </section>
    </div>
  `;

  const backButton = container.querySelector<HTMLButtonElement>('.pp-detail__back');
  backButton?.addEventListener('click', onBack);
  container.querySelector<HTMLElement>('.pp-detail__title')?.focus();

  const detailImg = container.querySelector<HTMLImageElement>('img.pp-detail__image');
  if (detailImg) {
    let triedCard = false;
    const handleFailure = () => {
      const cardFallback = dish.images?.card;
      if (!triedCard && cardFallback && detailImg.getAttribute('src') !== cardFallback.url) {
        triedCard = true;
        detailImg.src = cardFallback.url;
        detailImg.alt = cardFallback.alt;
        return;
      }
      const missing = document.createElement('div');
      missing.className = 'pp-detail__image pp-detail__image--missing';
      missing.setAttribute('aria-hidden', 'true');
      detailImg.replaceWith(missing);
    };
    detailImg.addEventListener('error', handleFailure);
    if (detailImg.complete && detailImg.naturalWidth === 0) {
      handleFailure();
    }
  }
  return bindPortionPreview(container, dish);
}
