// Wires the screens' own elements to the shared Save state (S3-DIN-02.2). Screens render an empty
// heart button, the header badge and a stable toast area
// (<div class="pp-toast-area" aria-live="polite" aria-atomic="true">); these functions attach the
// Save behaviour, so the layout stays with the screens. Each returns a function that detaches it.
import type { Dish, Menu } from '../menu/types';
import type { SaveSurface, SendEvent } from './events';
import { createSaveFeedback, type SaveFeedback, type Toast } from './feedback';
import type { SaveState } from './save-state';

// Figma toast copy (frames 751:10189 and 1091:2272; Rania's PR 122 review #5, agreed by Adam).
const REMOVED_TEXT = 'Removed from saved dishes';
const RESTORED_TEXT = 'Restored to saved dishes';
const UNDO_TEXT = 'Undo';

// Each toast's status icon sits in a circle (review #3); the colours come from save.css.
const STATUS_ICONS = {
  removed:
    '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="10" fill="currentColor"/><path d="M6 10h8" stroke="var(--pp-toast-icon-mark)" stroke-width="2" stroke-linecap="round"/></svg>',
  restored:
    '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="10" fill="currentColor"/><path d="m6 10.2 2.6 2.6L14 7.4" fill="none" stroke="var(--pp-toast-icon-mark)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
} as const;

// Until S3-DIN-01.5's track() (#65) is on this branch, screens pass `send`; events are otherwise
// not sent.
const noSend: SendEvent = () => {};

// `toast` is the one currently showing, kept here so a screen that mounts its toast area while it is
// showing (for example after navigating) gets it redrawn. Its timer stays in the feedback, so the
// original expiry holds; drawing never sends an event.
type Hub = { feedback: SaveFeedback; areas: HTMLElement[]; toast: Toast | null };
const hubs = new WeakMap<SaveState, Hub>();

// One feedback per Save state, so there is one toast and one Undo across every screen.
function hubFor(saveState: SaveState): Hub {
  const existing = hubs.get(saveState);
  if (existing) return existing;
  const hub: Hub = {
    areas: [],
    toast: null,
    feedback: createSaveFeedback(saveState, (toast) => {
      hub.toast = toast;
      draw(hub);
    }),
  };
  hubs.set(saveState, hub);
  return hub;
}

// The toast goes in the most recently mounted toast area that is still on the page.
function draw(hub: Hub) {
  const { toast } = hub;
  for (const area of hub.areas) area.replaceChildren();
  const area = [...hub.areas].reverse().find((candidate) => candidate.isConnected);
  if (!area || toast === null) return;
  const box = document.createElement('div');
  box.className = `pp-toast pp-toast--${toast.kind}`;
  const icon = document.createElement('span');
  icon.className = 'pp-toast__icon';
  icon.innerHTML = STATUS_ICONS[toast.kind];
  const text = document.createElement('span');
  text.className = 'pp-toast__text';
  text.textContent = toast.kind === 'removed' ? REMOVED_TEXT : RESTORED_TEXT;
  box.append(icon, text);
  if (toast.kind === 'removed') {
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'pp-toast__undo';
    undo.textContent = UNDO_TEXT;
    undo.addEventListener('click', toast.undo);
    box.append(undo);
  }
  area.append(box);
}

export function mountToastArea(element: HTMLElement, saveState: SaveState): () => void {
  const hub = hubFor(saveState);
  hub.areas.push(element);
  // A toast that is already showing moves into the new area (Sai's review, 4 Nov).
  draw(hub);
  return () => {
    hub.areas = hub.areas.filter((area) => area !== element);
    element.replaceChildren();
    // If another area is still mounted, the toast moves back there.
    draw(hub);
  };
}

export function mountSaveHeart(
  button: HTMLButtonElement,
  {
    saveState,
    menu,
    dish,
    surface,
    send = noSend,
  }: { saveState: SaveState; menu: Menu; dish: Dish; surface: SaveSurface; send?: SendEvent },
): () => void {
  const { feedback } = hubFor(saveState);
  feedback.useMenu(menu);
  const sync = () => {
    button.setAttribute('aria-pressed', String(saveState.isSaved(dish.dishId)));
  };
  const onClick = () => feedback.toggle({ menu, dish, surface, send });
  button.addEventListener('click', onClick);
  const stop = saveState.subscribe(sync);
  sync();
  return () => {
    button.removeEventListener('click', onClick);
    stop();
  };
}

// The header badge shows the saved count and is hidden at zero.
export function mountSaveBadge(element: HTMLElement, saveState: SaveState): () => void {
  const sync = () => {
    const count = saveState.savedCount();
    element.textContent = String(count);
    element.hidden = count === 0;
  };
  const stop = saveState.subscribe(sync);
  sync();
  return stop;
}
