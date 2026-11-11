import { PublicPortionSchema } from '@peekaplate/contracts';
import { createPortionMotion } from './portionMotion';
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
  const motion = createPortionMotion();
  let drag: { id: number; x: number; y: number } | undefined;
  const stop = () => {
    clearTimeout(timer);
    motion.key('Home');
    drag = undefined;
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
  const show = async (retrying = false, forceCss = false) => {
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
      const mounted = await mount(
        stage,
        parsed.data,
        controller.signal,
        () => {
          if (attempt === controller && !controller.signal.aborted) void show(true, true);
        },
        forceCss,
      );
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
    const next = motion.key(event.key);
    if (!next) return;
    event.preventDefault();
    renderer.update(next.x, next.y, 150);
  };
  const pointerdown = (event: PointerEvent) => {
    if (active && renderer && !reduced.matches && event.pointerType !== 'mouse') {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }
  };
  const pointer = (event: PointerEvent) => {
    if (!active || !renderer || reduced.matches) return;
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    let x: number;
    let y: number;
    if (event.pointerType === 'mouse') {
      x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      y = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
    } else {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      // PR25 touch behavior: horizontal drag tilts; vertical gestures keep native scrolling.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
        reset();
        return;
      }
      x = dx / (bounds.width * 0.35);
      y = 0;
    }
    const next = motion.pointer(x, y);
    renderer.update(next.x, next.y, 55);
  };
  const reset = () => {
    motion.key('Home');
    drag = undefined;
    renderer?.update(0, 0, reduced.matches ? 0 : 300);
  };
  const motionChanged = () => {
    reset();
    if (active && root.dataset.portionState === 'ready') {
      status.textContent = reduced.matches
        ? '2.5D preview. Motion is reduced.'
        : 'Drag to tilt the plate';
    }
  };
  const pointerup = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) reset();
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
  stage.addEventListener('pointerdown', pointerdown);
  stage.addEventListener('pointermove', pointer);
  window.addEventListener('pointerup', pointerup);
  stage.addEventListener('blur', reset);
  stage.addEventListener('pointercancel', reset);
  stage.addEventListener('pointerleave', reset);
  reduced.addEventListener('change', motionChanged);
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
    stage.removeEventListener('pointerdown', pointerdown);
    stage.removeEventListener('pointermove', pointer);
    window.removeEventListener('pointerup', pointerup);
    stage.removeEventListener('blur', reset);
    stage.removeEventListener('pointercancel', reset);
    stage.removeEventListener('pointerleave', reset);
    reduced.removeEventListener('change', motionChanged);
    if (history.state?.ppPortion === key) {
      const { ppPortion: _retired, ...rest } = history.state;
      history.replaceState(rest, '');
    }
  };
}
