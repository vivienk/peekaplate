// S13 Owner diner menu preview and publish (S6-DES-05; Figma "S13 / Preview Mode — Draft"
// 3123:12796, Not Ready 3123:12634, Publish Confirmation 3123:12795, Published — Success 3123:12742,
// Link copied 3123:12372; handoff 3123:12317, draft pending review).
//
// The phone shows the real diner app in a frame, so the owner sees exactly what diners see and can
// scroll, filter and open dishes. The diner address comes from the caller.
//
// Menu link (Sai, 15 Nov): no public link is shown before publishing. After a publish succeeds the
// caller passes the full URL the API returned; it is shown read-only with Copy Link. The screen never
// builds a URL itself. Figma shows a draft link before publishing; that difference is flagged.
//
// A presentational screen: the caller publishes and passes back what happened.
import { useEffect, useId, useRef, useState } from 'react';
import { ActionButton, ErrorBanner } from '../auth/parts';
import checkIcon from '../onboarding/assets/check.svg';
import { OnboardingLayout } from '../onboarding/OnboardingLayout';
import './publish.css';

export type MenuPreviewProps = {
  restaurantName: string;
  dishCount: number;
  categoryCount: number;
  /** The diner menu to show in the phone; null shows a short "not available" note instead. */
  dinerUrl: string | null;
  /** Dishes still missing a price or category; more than 0 blocks publishing (Not Ready). */
  dishesMissingDetails?: number;
  /** True while the publish request runs. */
  publishing?: boolean;
  /** The last publish attempt failed; the menu is still a draft. */
  publishFailed?: boolean;
  /** The full diner URL returned by the API once the menu is published. */
  publishedUrl?: string | null;
  onBackToEdit: () => void;
  onReviewDishes: () => void;
  /** Called after the owner confirms in the Publish Confirmation dialog. */
  onPublish: () => void;
  onGoToDashboard: () => void;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function MenuPreview({
  restaurantName,
  dishCount,
  categoryCount,
  dinerUrl,
  dishesMissingDetails = 0,
  publishing = false,
  publishFailed = false,
  publishedUrl = null,
  onBackToEdit,
  onReviewDishes,
  onPublish,
  onGoToDashboard,
}: MenuPreviewProps) {
  const ids = useId();
  const published = Boolean(publishedUrl);
  const notReady = !published && dishesMissingDetails > 0;
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  // A result replaces the preview: move focus to the new heading so it is announced.
  useEffect(() => {
    if (published) headingRef.current?.focus();
  }, [published]);

  const copy = async () => {
    if (!publishedUrl) return;
    try {
      await navigator.clipboard.writeText(publishedUrl);
      setCopied('copied');
    } catch {
      // The browser refused the clipboard: select the link so the owner can copy it by hand.
      urlRef.current?.select();
      setCopied('failed');
    }
  };

  const summary = `${plural(dishCount, 'dish', 'dishes')} · ${plural(categoryCount, 'category', 'categories')}`;

  return (
    <OnboardingLayout restaurantName={restaurantName} bare>
      <section className="pp-onboard__card pp-menu-preview" aria-labelledby={`${ids}-title`}>
        <header className="pp-menu-preview__head">
          <h1 className="pp-onboard__title" id={`${ids}-title`} ref={headingRef} tabIndex={-1}>
            {published ? 'Your menu is live' : 'Preview your menu'}
          </h1>
          <p className="pp-menu-preview__lead">
            {published
              ? 'Diners can now see your menu at the link below.'
              : 'This is exactly what diners will see. Nothing is public until you publish.'}
          </p>
        </header>

        {notReady && (
          <ErrorBanner
            copy={{
              title: 'Your menu isn’t ready to publish',
              body: `${plural(dishesMissingDetails, 'dish is', 'dishes are')} missing a price or category. Add the missing details, then publish.`,
            }}
            action={
              <button type="button" className="pp-menu-preview__link" onClick={onReviewDishes}>
                Review dishes
              </button>
            }
          />
        )}
        {publishFailed && !published && (
          <ErrorBanner
            copy={{
              title: 'We couldn’t publish your menu',
              body: 'Your menu is still a draft and nothing is public. Please try again.',
            }}
          />
        )}
        {copied === 'copied' && (
          <div className="pp-auth-banner pp-menu-preview__success" role="status">
            <span className="pp-auth-banner__icon" aria-hidden="true">
              <img src={checkIcon} alt="" width="24" height="24" />
            </span>
            <div className="pp-auth-banner__text">
              <p className="pp-auth-banner__title">Link copied.</p>
            </div>
          </div>
        )}
        {copied === 'failed' && (
          <ErrorBanner
            copy={{
              title: 'The link couldn’t be copied',
              body: 'It is selected below. Copy it with your keyboard or browser menu.',
            }}
          />
        )}

        <div className="pp-menu-preview__body">
          <div className="pp-menu-preview__diner">
            <span className={`pp-menu-preview__label${published ? ' is-live' : ''}`}>
              {published ? 'Live — Published' : 'Preview — Not Published'}
            </span>
            <div className="pp-menu-preview__phone">
              {dinerUrl ? (
                <iframe
                  className="pp-menu-preview__frame"
                  title={`${restaurantName} diner menu preview`}
                  src={dinerUrl}
                  sandbox="allow-scripts allow-same-origin"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <p className="pp-menu-preview__unavailable">
                  The diner preview isn’t available here.
                </p>
              )}
            </div>
          </div>

          <section className="pp-menu-preview__panel" aria-labelledby={`${ids}-link`}>
            <div className="pp-menu-preview__panel-head">
              <h2 id={`${ids}-link`}>Your menu link</h2>
              <span className={`pp-menu-preview__badge${published ? ' is-live' : ''}`}>
                {published ? 'Published' : 'Draft'}
              </span>
            </div>
            {published && publishedUrl ? (
              <>
                <div className="pp-menu-preview__url-row">
                  <label className="pp-visually-hidden" htmlFor={`${ids}-url`}>
                    Menu link
                  </label>
                  <input
                    ref={urlRef}
                    id={`${ids}-url`}
                    className="pp-menu-preview__url"
                    value={publishedUrl}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <ActionButton variant="outlined" size="medium" onClick={() => void copy()}>
                    Copy Link
                  </ActionButton>
                </div>
                <p className="pp-menu-preview__helper">
                  Your menu is public. Anyone with this link can open it.
                </p>
              </>
            ) : (
              <p className="pp-menu-preview__helper">
                Your menu link appears here after you publish. Until then diners can’t open your
                menu; only you and your staff can see this preview.
              </p>
            )}
            <p className="pp-menu-preview__summary">{summary}</p>
          </section>
        </div>

        <div className="pp-onboard__actions pp-menu-preview__actions">
          {published ? (
            <ActionButton onClick={onGoToDashboard}>Go to dashboard</ActionButton>
          ) : (
            <>
              <ActionButton variant="outlined" onClick={onBackToEdit}>
                Back to Edit
              </ActionButton>
              <ActionButton
                busy={publishing}
                busyLabel="Publishing"
                blocked={notReady}
                onClick={() => {
                  if (!notReady && !publishing) setConfirming(true);
                }}
              >
                Publish Menu
              </ActionButton>
            </>
          )}
        </div>
      </section>

      {confirming && (
        <PublishConfirmDialog
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onPublish();
          }}
        />
      )}
    </OnboardingLayout>
  );
}

// Publish Confirmation (3123:12850). Figma's text names the URL; before publishing there is none
// (Sai, 15 Nov), so the text says the menu becomes public without naming an address.
function PublishConfirmDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const ids = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="pp-menu-preview__dialog"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-text`}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={`${ids}-title`}>Publish your menu?</h2>
      <p id={`${ids}-text`}>
        Your menu will be public on PeekaPlate. Anyone with the link will be able to see it.
      </p>
      <div className="pp-menu-preview__dialog-actions">
        <ActionButton variant="outlined" onClick={onCancel}>
          Cancel
        </ActionButton>
        <ActionButton onClick={onConfirm}>Publish Menu</ActionButton>
      </div>
    </dialog>
  );
}
