// FE-04 follow-up: the Terms and Conditions and Privacy Policy pop-ups opened from the S01 Create
// account agreement. A native modal <dialog>: it traps focus, makes the page behind inert, and
// closes on Escape, on the close buttons, or on a click outside it. Focus returns to the link that
// opened it. Reading a document doesn't tick the agreement; the owner still ticks the checkbox.
import { useEffect, useId, useRef } from 'react';
import { ActionButton } from '../auth/parts';
import { LegalBody, type LegalDocument, parseLegalMarkdown } from './markdown';
import privacySource from './privacy-policy.md?raw';
import termsSource from './terms.md?raw';
import './legal.css';

export type LegalDocumentId = 'terms' | 'privacy';

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = {
  terms: parseLegalMarkdown(termsSource),
  privacy: parseLegalMarkdown(privacySource),
};

export function LegalDialog({
  document: id,
  onClose,
}: {
  document: LegalDocumentId;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { title, blocks } = LEGAL_DOCUMENTS[id];

  useEffect(() => {
    const dialog = ref.current;
    const opener = dialog?.ownerDocument.activeElement as HTMLElement | null;
    // showModal() traps focus and makes the page behind inert; jsdom and old browsers lack it.
    if (dialog && !dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      opener?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="pp-legal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape closes it the same way as the buttons.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The panel fills the dialog, so a click on the dialog itself is a click on the backdrop.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="pp-legal__panel">
        <header className="pp-legal__header">
          <h2 id={titleId} className="pp-legal__title">
            {title}
          </h2>
          <button type="button" className="pp-legal__close" aria-label="Close" onClick={onClose}>
            <svg width="16" height="16" viewBox="14 14 16 16" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M28 16a1 1 0 0 0-1.41 0L22 20.58 17.41 16A1 1 0 0 0 16 17.41L20.59 22 16 26.58A1 1 0 0 0 17.41 28L22 23.41 26.59 28A1 1 0 0 0 28 26.58L23.41 22 28 17.41A1 1 0 0 0 28 16Z"
              />
            </svg>
          </button>
        </header>
        {/* Focusable so keyboard users can scroll it; named by the dialog title. */}
        <section className="pp-legal__body" tabIndex={0} aria-labelledby={titleId}>
          <LegalBody blocks={blocks} />
        </section>
        <footer className="pp-legal__footer">
          <ActionButton size="medium" onClick={onClose}>
            Close
          </ActionButton>
        </footer>
      </div>
    </dialog>
  );
}
