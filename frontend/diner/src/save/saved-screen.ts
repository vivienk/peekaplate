// The Saved screen (S3-DIN-02.5): the diner's saved dishes, newest first. Like the DIN-01 screens it
// renders into a container and navigates through callbacks; it is built with DOM methods, so dish
// text is never parsed as markup. Copy and look are provisional until the Figma Saved frames are
// applied.
import type { CompleteDish, Menu } from '../menu/types';
import type { SendEvent } from './events';
import { mountSaveHeart, mountToastArea } from './mount';
import type { SaveState } from './save-state';
import { type SavedItem, savedItems, shortlistViewedPayload } from './saved-screen-model';

export const SESSION_ONLY_NOTICE = 'Saved for this session only';
const PLACEHOLDER_TEXT = 'More information needed — pending restaurant input';

const noSend: SendEvent = () => {};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function money(dish: CompleteDish): string {
  return `${dish.price.currency} ${dish.price.amount}`.trim();
}

export type SavedScreenOptions = {
  saveState: SaveState;
  menu: Menu;
  // Opens the standard dish detail; the caller tracks dish_detail_opened with source saved_screen.
  onOpenDish: (dish: CompleteDish) => void;
  // Leaves the Saved screen: the back button and "Browse menu".
  onBack: () => void;
  send?: SendEvent;
};

// Call once per readable display of the Saved screen (navigating to it, going back to it, or a
// reload while on it); each call sends one shortlist_viewed. Changes while it is shown (removing a
// dish, Undo, the session-only switch) redraw the list without another view. Returns cleanup.
export function renderSavedScreen(
  container: HTMLElement,
  { saveState, menu, onOpenDish, onBack, send = noSend }: SavedScreenOptions,
): () => void {
  const screen = el('div', 'pp-saved');
  const header = el('header', 'pp-saved__topbar');
  const back = el('button', 'pp-saved__back', '←');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to menu');
  back.addEventListener('click', onBack);
  header.append(back, el('h1', 'pp-saved__title', 'Saved'));

  // A stable toast area under the header, outside the redrawn list.
  const toastArea = el('div', 'pp-toast-area');
  toastArea.setAttribute('aria-live', 'polite');
  toastArea.setAttribute('aria-atomic', 'true');

  const notice = el('p', 'pp-saved__notice', SESSION_ONLY_NOTICE);
  notice.setAttribute('role', 'status');
  const content = el('div', 'pp-saved__content');
  screen.append(header, toastArea, notice, content);
  container.replaceChildren(screen);

  const stopToasts = mountToastArea(toastArea, saveState);
  let stopHearts: (() => void)[] = [];

  function heart(item: SavedItem): HTMLButtonElement {
    const button = el('button', 'pp-saved__save');
    button.type = 'button';
    button.setAttribute(
      'aria-label',
      item.kind === 'complete' ? `Save ${item.dish.name}` : 'Remove this dish from Saved',
    );
    const icon = el('span', '', '♡');
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    stopHearts.push(
      mountSaveHeart(button, { saveState, menu, dish: item.dish, surface: 'saved_screen', send }),
    );
    return button;
  }

  function card(item: SavedItem): HTMLLIElement {
    const row = el('li', 'pp-saved__item');
    if (item.kind === 'incomplete') {
      // Not openable or comparable, and no events; the heart can still remove it.
      const placeholder = el('article', 'pp-card pp-card--placeholder');
      placeholder.append(el('p', 'pp-card__placeholder', PLACEHOLDER_TEXT));
      row.append(placeholder, heart(item));
      return row;
    }
    const { dish } = item;
    const open = el('button', 'pp-saved__open');
    open.type = 'button';
    if (dish.images) {
      const image = el('img', 'pp-saved__image');
      image.src = dish.images.card.url;
      image.alt = dish.images.card.alt;
      image.width = dish.images.card.width;
      image.height = dish.images.card.height;
      open.append(image);
    }
    open.append(
      el('span', 'pp-saved__name', dish.name),
      el('span', 'pp-saved__price', money(dish)),
    );
    open.addEventListener('click', () => onOpenDish(dish));
    row.append(open, heart(item));
    return row;
  }

  function draw() {
    for (const stop of stopHearts) stop();
    stopHearts = [];
    notice.hidden = saveState.mode() !== 'session-only';
    const items = savedItems(saveState, menu);
    if (items.length === 0) {
      const empty = el('div', 'pp-saved__empty');
      const browse = el('button', 'pp-saved__browse', 'Browse menu');
      browse.type = 'button';
      browse.addEventListener('click', onBack);
      empty.append(el('p', 'pp-saved__empty-text', 'No saved dishes yet'), browse);
      content.replaceChildren(empty);
      return;
    }
    const list = el('ul', 'pp-saved__list');
    list.append(...items.map(card));
    content.replaceChildren(list);
  }

  draw();
  const stop = saveState.subscribe(draw);

  // Pending confirmation: the ticket says unavailable-storage states fire nothing, so the view is
  // not counted in session-only mode.
  if (saveState.mode() === 'persistent') {
    try {
      send('shortlist_viewed', shortlistViewedPayload(menu, saveState.savedCount()));
    } catch {}
  }

  return () => {
    stop();
    for (const stopHeart of stopHearts) stopHeart();
    stopToasts();
    container.replaceChildren();
  };
}
