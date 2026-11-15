// S5-FE-10 / S10 "Menu Review" screen (Figma frames S10_Review — Default and S10_Ready to publish).
// Presentational: the parent owns the draft data, the S09 form and navigation, and passes them in, so
// the owner draft API can be connected without changing this UI. This screen never publishes:
// "Complete verification" shows the "Menu verified" pop-up (verification does not publish), and its
// "Go to dashboard" button hands over to the parent, which opens S12 (first dashboard), where step 3
// (Review and publish) comes next.
import { useEffect, useRef } from 'react';
import { Button } from '../../ui';
import { ICONS } from '../icons';
import {
  categoryLabel,
  dishMeta,
  dishStatus,
  formatPrice,
  isMenuReady,
  type ReviewDish,
  type ReviewState,
} from './reviewDishes';

export interface ReviewDishesProps {
  embedded?: boolean;
  busy?: boolean;
  removalUnavailable?: string;
  verificationUnavailable?: string | undefined;
  canEditDish?: (id: string) => boolean;
  restaurantName: string;
  state: ReviewState;
  /** Opens the empty S09 form. */
  onAddDish: () => void;
  /** Opens the selected dish in S09. */
  onEditDish: (id: string) => void;
  onRemoveDish: (id: string) => void;
  onUndoRemove: () => void;
  /** Left button while a dish is not Ready. Confirmed: goes back to Screen 8. */
  onCancel: () => void;
  /** Saves progress and opens the first-time dashboard. */
  onSaveAndExit: () => void;
  /**
   * Shown only when every dish is Ready. Confirmed: opens the first-time dashboard with step 2
   * complete and step 3 (Review and publish) next. Nothing is published here.
   */
  onCompleteVerification: () => void;
  /** True while the parent is completing verification, so it cannot be sent twice. */
  completing?: boolean;
  /** Plain-language reason when completing failed; the owner can try again. */
  completeError?: string | null;
  /** True once verification succeeded: shows the "Menu verified" pop-up. Nothing is published. */
  verified?: boolean;
  /** "Go to dashboard" in the pop-up: the parent opens S12 (first dashboard). */
  onGoToDashboard: () => void;
}

/**
 * Figma "Menu verified" pop-up. It has one button and no close control, so Escape does not close it:
 * the owner continues with Go to dashboard. A native modal dialog keeps focus and the page behind it
 * inert; the one button takes focus when it opens.
 */
function MenuVerifiedDialog({ onGoToDashboard }: { onGoToDashboard: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="review-verified"
      aria-labelledby="review-verified-title"
      aria-describedby="review-verified-text"
      onCancel={(event) => event.preventDefault()}
    >
      <span className="review-verified__icon" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" focusable="false">
          <path
            d="M5 12.5l4.5 4.5L19 7.5"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h2 id="review-verified-title">Menu verified</h2>
      <p id="review-verified-text">
        Your menu details are confirmed. Verification does not publish your menu.
      </p>
      <Button
        variant="action"
        className="owner-button review-verified__button"
        onClick={onGoToDashboard}
      >
        Go to dashboard
      </Button>
    </dialog>
  );
}

function TrashIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const dishName = (dish: ReviewDish) => dish.name?.trim() || 'Unnamed dish';

export function ReviewDishes({
  embedded = false,
  busy = false,
  removalUnavailable,
  verificationUnavailable,
  canEditDish = () => true,
  restaurantName,
  state,
  onAddDish,
  onEditDish,
  onRemoveDish,
  onUndoRemove,
  onCancel,
  onSaveAndExit,
  onCompleteVerification,
  completing = false,
  completeError = null,
  verified = false,
  onGoToDashboard,
}: ReviewDishesProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const lastRemoved = useRef<string | null>(null);
  const removedId = state.removed?.dish.id ?? null;
  const ready = isMenuReady(state.dishes);
  const count = state.dishes.length;
  const Content = embedded ? 'section' : 'main';

  // The button the owner just used disappears with its row (Remove) or with the notice (Undo), so
  // keyboard focus moves to the next useful control instead of being lost.
  useEffect(() => {
    if (state.notice === 'removed' && removedId !== null) {
      lastRemoved.current = removedId;
      undoRef.current?.focus();
    } else if (state.notice === 'restored' && lastRemoved.current !== null) {
      const id = lastRemoved.current;
      lastRemoved.current = null;
      const edits = rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-edit-dish-id]');
      Array.from(edits ?? [])
        .find((button) => button.dataset.editDishId === id)
        ?.focus();
    }
  }, [state.notice, removedId]);

  return (
    <div className="owner-root review-root" ref={rootRef}>
      {!embedded && (
        <header className="review-topbar">
          <span className="review-brand">
            <img src={ICONS.logo} alt="" width={28} height={28} />
            <span className="review-brand__name">PeekaPlate</span>
          </span>
          <span className="review-identity">
            <span className="review-identity__kind">Owner Portal</span>
            <span className="review-identity__name">{restaurantName}</span>
          </span>
        </header>
      )}

      <Content className="review-card" id="owner-review">
        <div className="review-head">
          <div>
            <h1>Your dishes</h1>
            <p className="review-sub">
              {count} dish{count === 1 ? '' : 'es'} {embedded ? 'saved' : 'extracted'}
            </p>
          </div>
          <Button
            variant="text"
            className="owner-button review-add"
            aria-label="Add dish"
            disabled={busy}
            onClick={onAddDish}
          >
            + Add dish
          </Button>
        </div>

        <div className="review-notice-area" role="status" aria-live="polite">
          {state.notice === 'removed' && (
            <div className="review-notice review-notice--removed">
              <strong>Dish removed.</strong>
              <button type="button" className="review-undo" ref={undoRef} onClick={onUndoRemove}>
                Undo
              </button>
            </div>
          )}
          {state.notice === 'restored' && (
            <div className="review-notice review-notice--restored">
              <strong>Dish restored.</strong>
            </div>
          )}
        </div>

        {count === 0 ? (
          <p className="review-empty">No dishes yet. Add a dish to start your menu.</p>
        ) : (
          <div className="review-table-wrap">
            <table className="review-table">
              <caption className="owner-visually-hidden">
                Dishes in your menu with what is still missing
              </caption>
              <thead>
                <tr>
                  <th scope="col">Dish</th>
                  <th scope="col">Category</th>
                  <th scope="col">Price</th>
                  <th scope="col">Status</th>
                  <th scope="col">Review / Remove</th>
                </tr>
              </thead>
              <tbody>
                {state.dishes.map((dish) => {
                  const status = dishStatus(dish);
                  const name = dishName(dish);
                  return (
                    <tr key={dish.id} data-dish-id={dish.id}>
                      <th scope="row" className="review-dish">
                        <span className="review-dish__name">{name}</span>
                        <span className="review-dish__meta">{dishMeta(dish)}</span>
                      </th>
                      <td>{categoryLabel(dish)}</td>
                      <td>{formatPrice(dish.priceAmount, dish.priceCurrency)}</td>
                      <td>
                        <span className={`review-status review-status--${status.tone}`}>
                          {status.label}
                        </span>
                      </td>
                      <td>
                        <span className="review-actions">
                          <Button
                            disabled={busy || !canEditDish(dish.id)}
                            variant="outline"
                            className="owner-button review-edit"
                            data-edit-dish-id={dish.id}
                            aria-label={`Review ${name}`}
                            onClick={() => onEditDish(dish.id)}
                          >
                            Review
                          </Button>
                          <button
                            disabled={busy || Boolean(removalUnavailable)}
                            title={removalUnavailable}
                            type="button"
                            className="review-trash"
                            aria-label={`Remove ${name}`}
                            onClick={() => onRemoveDish(dish.id)}
                          >
                            <TrashIcon />
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {completeError && (
          <p className="review-error" role="alert">
            {completeError}
          </p>
        )}

        <div className="review-footer">
          {ready ? (
            <>
              <Button
                variant="outline"
                className="owner-button"
                disabled={busy}
                onClick={onSaveAndExit}
              >
                Save and Exit
              </Button>
              <Button
                variant="action"
                className="owner-button"
                disabled={completing || busy || Boolean(verificationUnavailable)}
                title={verificationUnavailable}
                aria-busy={completing}
                onClick={onCompleteVerification}
              >
                Complete verification
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" className="owner-button" disabled={busy} onClick={onCancel}>
                Cancel
              </Button>
              <Button
                variant="action"
                className="owner-button"
                disabled={busy}
                onClick={onSaveAndExit}
              >
                Save and Exit
              </Button>
            </>
          )}
        </div>
      </Content>
      {verified && <MenuVerifiedDialog onGoToDashboard={onGoToDashboard} />}
    </div>
  );
}
