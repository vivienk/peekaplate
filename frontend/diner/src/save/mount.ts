// Wires the screens' own elements to the shared Save state (S3-DIN-02.2). Screens render an empty
// heart button, the header badge and a stable toast area
// (<div class="pp-toast-area" aria-live="polite" aria-atomic="true">); these functions attach the
// Save behaviour, so the layout stays with the screens. Each returns a function that detaches it.
import type { Dish, Menu } from '../menu/types';
import type { SaveSurface, SendEvent } from './events';
import { createSaveFeedback, type SaveFeedback, type Toast } from './feedback';
import type { SaveState } from './save-state';

// Provisional copy until the Figma toast frames are applied.
const REMOVED_TEXT = 'Removed from Saved';
const RESTORED_TEXT = 'Added back to Saved';
const UNDO_TEXT = 'Undo';

// Until S3-DIN-01.5's track() (#65) is on this branch, screens pass `send`; events are otherwise
// not sent.
const noSend: SendEvent = () => {};

type Hub = { feedback: SaveFeedback; areas: HTMLElement[] };
const hubs = new WeakMap<SaveState, Hub>();

// One feedback per Save state, so there is one toast and one Undo across every screen.
function hubFor(saveState: SaveState): Hub {
  const existing = hubs.get(saveState);
  if (existing) return existing;
  const hub: Hub = {
    areas: [],
    feedback: createSaveFeedback(saveState, (toast) => draw(hub, toast)),
  };
  hubs.set(saveState, hub);
  return hub;
}

// The toast goes in the most recently mounted toast area that is still on the page.
function draw(hub: Hub, toast: Toast | null) {
  for (const area of hub.areas) area.replaceChildren();
  const area = [...hub.areas].reverse().find((candidate) => candidate.isConnected);
  if (!area || toast === null) return;
  const box = document.createElement('div');
  box.className = 'pp-toast';
  const text = document.createElement('span');
  text.className = 'pp-toast__text';
  text.textContent = toast.kind === 'removed' ? REMOVED_TEXT : RESTORED_TEXT;
  box.append(text);
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
  return () => {
    hub.areas = hub.areas.filter((area) => area !== element);
    element.replaceChildren();
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
