// S5-FE-10 / S10 "Menu Review and Publish" screen (Figma frames S10_Review and S10_Ready to publish,
// developer handoff node 2793:15371). Presentational: the parent owns the draft data, the S09 form
// and the publish call, and passes them in, so the owner draft API can be connected without
// changing this UI. Publishing is never started here unless the owner presses Publish Menu.
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
  restaurantName: string;
  state: ReviewState;
  /** Opens the empty S09 form. */
  onAddDish: () => void;
  /** Opens the selected dish in S09. */
  onEditDish: (id: string) => void;
  onRemoveDish: (id: string) => void;
  onUndoRemove: () => void;
  /** Destination and save behavior are still to be confirmed with design. */
  onBack: () => void;
  /** Saves progress and returns to S12. */
  onSaveAndExit: () => void;
  /** Starts publication. The parent confirms success with the API before showing the pop-up. */
  onPublish: () => void;
  /** True while the publish request is running, so it cannot be sent twice. */
  publishing?: boolean;
  /** Plain-language reason when publishing failed; the owner can try again. */
  publishError?: string | null;
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
  restaurantName,
  state,
  onAddDish,
  onEditDish,
  onRemoveDish,
  onUndoRemove,
  onBack,
  onSaveAndExit,
  onPublish,
  publishing = false,
  publishError = null,
}: ReviewDishesProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const lastRemoved = useRef<string | null>(null);
  const removedId = state.removed?.dish.id ?? null;
  const ready = isMenuReady(state.dishes);
  const count = state.dishes.length;

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

      <main className="review-card" id="owner-review">
        <div className="review-head">
          <div>
            <h1>Your dishes</h1>
            <p className="review-sub">
              {count} dish{count === 1 ? '' : 'es'}
            </p>
          </div>
          <Button variant="text" className="owner-button" onClick={onAddDish}>
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
                  <th scope="col">Edit / Remove</th>
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
                      <td>{formatPrice(dish.priceAmount)}</td>
                      <td>
                        <span className={`review-status review-status--${status.tone}`}>
                          {status.label}
                        </span>
                      </td>
                      <td>
                        <span className="review-actions">
                          <Button
                            variant="outline"
                            className="owner-button review-edit"
                            data-edit-dish-id={dish.id}
                            aria-label={`Edit ${name}`}
                            onClick={() => onEditDish(dish.id)}
                          >
                            Edit
                          </Button>
                          <button
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

        {publishError && (
          <p className="review-error" role="alert">
            {publishError}
          </p>
        )}

        <div className="review-footer">
          <Button variant="text" className="owner-button" onClick={onBack}>
            Back
          </Button>
          <Button variant="outline" className="owner-button" onClick={onSaveAndExit}>
            Save and Exit
          </Button>
          <Button
            variant="action"
            className="owner-button"
            disabled={!ready || publishing}
            aria-busy={publishing}
            onClick={onPublish}
          >
            Publish Menu
          </Button>
        </div>
        {!ready && count > 0 && (
          <p className="review-hint">Publish Menu opens when every dish is Ready.</p>
        )}
      </main>
    </div>
  );
}
