import { PublicPortionSchema } from '@peekaplate/contracts';
import type { PortionRenderer } from './portionRenderer';
import type { CompleteDish } from './types';

// Reuses the mounted detail screen: no separate page, duplicated dish data or global asset lookup.
export function bindPortionPreview(container: HTMLElement, dish: CompleteDish): () => void {
  const root = container.querySelector<HTMLElement>('.pp-detail');
  const open = container.querySelector<HTMLButtonElement>('.pp-detail__portion');
  const back = container.querySelector<HTMLButtonElement>('.pp-detail__back');
  const title = container.querySelector<HTMLElement>('.pp-detail__title');
  const stage = container.querySelector<HTMLElement>('.pp-detail__image-wrap');
  const status = container.querySelector<HTMLElement>('.pp-portion__status');
  if (!root || !open || !back || !title || !stage || !status) return () => {};
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'pp-portion__retry';
  retry.textContent = 'Try again';
  retry.hidden = true;
  status.after(retry);
  const key = crypto.randomUUID();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let active = false;
  let disposed = false;
  let closing = false;
  let scroll = 0;
  let attempt: AbortController | undefined;
  let renderer: PortionRenderer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let x = 0;
  let y = 0;
  const stop = () => {
    clearTimeout(timer);
    attempt?.abort();
    renderer?.dispose();
    renderer = undefined;
    stage.classList.remove('pp-portion--ready');
    stage.removeAttribute('tabindex');
    stage.removeAttribute('role');
    stage.removeAttribute('aria-label');
    stage.removeAttribute('aria-description');
  };
  const setState = (state: 'loading' | 'ready' | 'fallback' | 'failed') => {
    root.dataset.portionState = state;
    retry.hidden = state !== 'failed';
    stage.setAttribute('aria-busy', String(state === 'loading'));
  };
  const fallback = () => {
    stop();
    if (!active || disposed) return;
    const hasPhoto = !!stage.querySelector('img');
    setState(hasPhoto ? 'fallback' : 'failed');
    status.replaceChildren();
    if (hasPhoto) {
      const heading = document.createElement('strong');
      heading.textContent = 'Interactive preview unavailable';
      const message = document.createElement('span');
      message.textContent = 'Showing photo instead';
      status.append(heading, message);
    } else {
      status.textContent = 'Couldn’t load preview.\nPlease try again.';
    }
  };
  const photoObserver = new MutationObserver(() => {
    if (active && root.dataset.portionState === 'fallback' && !stage.querySelector('img')) {
      fallback();
    }
  });
  photoObserver.observe(stage, { childList: true });
  const show = async (retrying = false) => {
    if ((active && !retrying) || disposed) return;
    stop();
    active = true;
    closing = false;
    root.classList.add('pp-detail--preview');
    title.textContent = dish.name;
    back.setAttribute('aria-label', 'Back to dish details');
    status.hidden = false;
    setState('loading');
    status.textContent = 'Loading Interactive preview...';
    back.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    const parsed = PublicPortionSchema.safeParse(dish.portion);
    if (
      !parsed.success ||
      parsed.data.dish_id !== dish.dishId ||
      parsed.data.dish_revision_id !== dish.dishRevisionId
    ) {
      fallback();
      return;
    }
    const controller = new AbortController();
    attempt = controller;
    timer = setTimeout(fallback, 8000);
    try {
      const { mount } = await import('./portionRenderer');
      if (controller.signal.aborted) return;
      const mounted = await mount(stage, parsed.data, controller.signal, fallback);
      if (controller.signal.aborted || disposed) {
        mounted.dispose();
        return;
      }
      renderer = mounted;
      clearTimeout(timer);
      stage.classList.add('pp-portion--ready');
      stage.tabIndex = 0;
      stage.setAttribute('role', 'group');
      stage.setAttribute('aria-label', `${dish.name} portion preview`);
      stage.setAttribute(
        'aria-description',
        'Use arrow keys for a slight tilt. Escape returns to dish details.',
      );
      setState('ready');
      status.textContent = reduced.matches
        ? '2.5D preview. Motion is reduced.'
        : 'Drag to tilt the plate';
    } catch {
      if (attempt === controller && !controller.signal.aborted) fallback();
    }
  };
  const hide = () => {
    if (!active) return;
    active = false;
    closing = false;
    stop();
    root.classList.remove('pp-detail--preview');
    delete root.dataset.portionState;
    stage.removeAttribute('aria-busy');
    retry.hidden = true;
    title.textContent = 'Dish details';
    back.setAttribute('aria-label', 'Back to menu');
    status.hidden = true;
    open.focus({ preventScroll: true });
    window.scrollTo(0, scroll);
  };
  const close = () => {
    if (!active || closing) return;
    if (history.state?.ppPortion === key) {
      closing = true;
      history.back();
    } else hide();
  };
  const openPreview = () => {
    if (active) return;
    scroll = window.scrollY;
    history.pushState({ ...history.state, ppPortion: key }, '');
    void show();
  };
  const backClick = (event: Event) => {
    if (!active) return;
    event.stopImmediatePropagation();
    close();
  };
  const pop = () => {
    if (history.state?.ppPortion === key) void show();
    else hide();
  };
  const keydown = (event: KeyboardEvent) => {
    if (!active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.target !== stage || reduced.matches || !renderer) return;
    const delta = (
      {
        ArrowLeft: [-0.25, 0],
        ArrowRight: [0.25, 0],
        ArrowUp: [0, -0.25],
        ArrowDown: [0, 0.25],
        Home: [-x, -y],
      } as Record<string, number[]>
    )[event.key];
    if (!delta) return;
    event.preventDefault();
    x = Math.max(-1, Math.min(1, x + (delta[0] ?? 0)));
    y = Math.max(-1, Math.min(1, y + (delta[1] ?? 0)));
    renderer.update(x, y);
  };
  const pointer = (event: PointerEvent) => {
    if (!active || !renderer || reduced.matches || !event.buttons) return;
    const bounds = stage.getBoundingClientRect();
    x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1));
    y = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1));
    renderer.update(x, y);
  };
  const reset = () => {
    x = 0;
    y = 0;
    renderer?.update(0, 0);
  };
  const retryPreview = () => {
    const photo = dish.images?.detail ?? dish.images?.card;
    if (photo && !stage.querySelector('img')) {
      const img = document.createElement('img');
      img.className = 'pp-detail__image';
      img.alt = photo.alt;
      let triedCard = false;
      img.addEventListener('error', () => {
        if (disposed) return;
        const card = dish.images?.card;
        if (!triedCard && card && img.getAttribute('src') !== card.url) {
          triedCard = true;
          img.src = card.url;
          img.alt = card.alt;
          return;
        }
        const missing = document.createElement('div');
        missing.className = 'pp-detail__image pp-detail__image--missing';
        missing.setAttribute('aria-hidden', 'true');
        img.replaceWith(missing);
        if (active && root.dataset.portionState === 'fallback') fallback();
      });
      stage.querySelector('.pp-detail__image--missing')?.remove();
      stage.append(img);
      img.src = photo.url;
    }
    void show(true);
  };
  retry.addEventListener('click', retryPreview);
  open.addEventListener('click', openPreview);
  back.addEventListener('click', backClick, true);
  window.addEventListener('popstate', pop);
  document.addEventListener('keydown', keydown);
  stage.addEventListener('pointermove', pointer);
  stage.addEventListener('pointerup', reset);
  stage.addEventListener('pointercancel', reset);
  stage.addEventListener('pointerleave', reset);
  reduced.addEventListener('change', reset);
  return () => {
    disposed = true;
    stop();
    photoObserver.disconnect();
    retry.removeEventListener('click', retryPreview);
    retry.remove();
    open.removeEventListener('click', openPreview);
    back.removeEventListener('click', backClick, true);
    window.removeEventListener('popstate', pop);
    document.removeEventListener('keydown', keydown);
    stage.removeEventListener('pointermove', pointer);
    stage.removeEventListener('pointerup', reset);
    stage.removeEventListener('pointercancel', reset);
    stage.removeEventListener('pointerleave', reset);
    reduced.removeEventListener('change', reset);
    if (history.state?.ppPortion === key) {
      const { ppPortion: _retired, ...rest } = history.state;
      history.replaceState(rest, '');
    }
  };
}
