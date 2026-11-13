// Modal AI drawer for narrow screens: moves focus inside on open, keeps Tab inside, makes the
// page behind it inert, closes on Escape or the scrim, and returns focus to the opener on close.
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && el.getClientRects().length > 0,
  );

export function ModalDrawer({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const wrap = wrapRef.current;
    const dialog = dialogRef.current;
    // Everything beside the drawer becomes inert, except live status messages (toast).
    const background = wrap?.parentElement
      ? Array.from(wrap.parentElement.children).filter(
          (el): el is HTMLElement =>
            el instanceof HTMLElement && el !== wrap && !el.matches('[role="status"]'),
        )
      : [];
    for (const el of background) el.inert = true;
    if (dialog) (focusables(dialog)[0] ?? dialog).focus();
    return () => {
      for (const el of background) el.inert = false;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const items = focusables(dialogRef.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={wrapRef}>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        className="drawer-p"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
