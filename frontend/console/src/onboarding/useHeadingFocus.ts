// Keyboard and screen-reader users land on the new screen's heading after each screen change
// (Rania, #213 review: "move focus to the new page heading after each screen transition").
// The first render is left alone (the browser's own page focus applies). A screen that already
// placed focus itself (a field, an open dialog) keeps it: the heading only takes focus when the
// previous focus was lost, which is what happens when the old screen's button unmounts.
import { useEffect, useRef } from 'react';

export function focusScreenHeading(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (active && active !== doc.body && active.isConnected) return false;
  if (doc.querySelector('dialog[open]')) return false;
  const heading = doc.querySelector<HTMLElement>('main h1') ?? doc.querySelector<HTMLElement>('h1');
  if (!heading) return false;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus();
  return true;
}

export function useHeadingFocus(screen: unknown) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // After the new screen's own effects (which may focus a field) have run.
    const frame = window.requestAnimationFrame(() => focusScreenHeading());
    return () => window.cancelAnimationFrame(frame);
  }, [screen]);
}
