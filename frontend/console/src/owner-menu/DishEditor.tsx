// FE-06.2 Screen 9 (Add/Edit Dish) on the owner menu workspace fields. Adapted from the DishForm
// in Jeffin's owner-dashboard demo (#105): same order of fields, error summary and ingredient
// tags, but driven by DishForm values from dishForm.ts instead of the demo's MenuItem, with the
// explicit unknown/proposed/confirmed states the draft API keeps and the OCR source beside the
// fields. There are no AI draft buttons: saving never calls a model or invents text.
//
// The parent owns loading and saving (api.ts). This component only edits values, shows what is
// missing for verification, and calls onSave / onVerify / onCancel.
import { type FormEvent, useId, useState } from 'react';
import { TextField } from '../foundations/TextField';
import { Button } from '../ui';
import {
  type AllergenCode,
  type ApprovalIssue,
  allergenOutcome,
  approvalIssues,
  type DishForm,
  STAFF_ALLERGY_LINE,
  type ValueStatus,
} from './dishForm';
import type { EvidenceExcerpt } from './evidence';
import './dishEditor.css';

export const ALLERGEN_CODES: readonly AllergenCode[] = [
  'milk',
  'egg',
  'fish',
  'crustacean shellfish',
  'nuts',
  'peanut',
  'wheat',
  'soy',
  'sesame',
];

const ALLERGEN_LABEL = (code: AllergenCode) => code.charAt(0).toUpperCase() + code.slice(1);

const STATUS_LABEL: Record<ValueStatus, string> = {
  unknown: 'Not known yet',
  proposed: 'Draft (not checked)',
  confirmed: 'Confirmed by me',
};

const ISSUE_TEXT: Record<ApprovalIssue, { field: string; text: string }> = {
  name: { field: 'dish-name', text: 'Enter a dish name.' },
  category: { field: 'dish-category', text: 'Enter a category.' },
  price: { field: 'dish-price', text: 'Enter a price, for example 12.50.' },
  currency: { field: 'dish-currency', text: 'Enter a three-letter currency, for example USD.' },
  rejected: {
    field: 'dish-name',
    text: 'This dish was rejected in review and cannot be verified.',
  },
};

export type DishEditorProps = {
  value: DishForm;
  onChange: (next: DishForm) => void;
  // Saves the draft as it is; fields may still be incomplete.
  onSave: () => void;
  // Owner verification (approval). Shown only when the parent can approve this dish.
  onVerify?: () => void;
  onCancel: () => void;
  busy?: boolean;
  // A save/verify failure message from the parent (already in owner-facing words).
  error?: string | null;
  // OCR source text for an extracted dish.
  evidence?: readonly EvidenceExcerpt[];
};

export function DishEditor({
  value,
  onChange,
  onSave,
  onVerify,
  onCancel,
  busy = false,
  error = null,
  evidence = [],
}: DishEditorProps) {
  const [issues, setIssues] = useState<ApprovalIssue[]>([]);
  const [ingredient, setIngredient] = useState('');
  const summaryId = useId();
  const extracted = value.origin === 'extracted';
  const uncertain = new Set(value.source?.uncertainFields ?? []);
  const set = (patch: Partial<DishForm>) => onChange({ ...value, ...patch });
  const issueFor = (field: ApprovalIssue) =>
    issues.includes(field) ? ISSUE_TEXT[field].text : undefined;
  const check = (field: string, message: string) => (uncertain.has(field) ? message : undefined);

  const addIngredient = () => {
    const name = ingredient.trim();
    if (!name || value.ingredients.items.includes(name)) return;
    set({
      ingredients: {
        status: value.ingredients.status === 'unknown' ? 'proposed' : value.ingredients.status,
        items: [...value.ingredients.items, name],
      },
    });
    setIngredient('');
  };

  const verify = (event: FormEvent) => {
    event.preventDefault();
    const found = approvalIssues(value);
    setIssues(found);
    if (found.length > 0) {
      setTimeout(() => document.getElementById(summaryId)?.focus(), 0);
      return;
    }
    onVerify?.();
  };

  const allergens = allergenOutcome(value);

  return (
    <form className="pp-dish-editor" onSubmit={verify} noValidate aria-busy={busy}>
      <p className="eyebrow">{extracted ? 'Review scanned dish' : 'Add dish'} · Screen 9</p>
      <h1>{value.name.trim() || 'New dish'}</h1>

      {issues.length > 0 && (
        <div id={summaryId} tabIndex={-1} role="alert" className="pp-dish-editor__summary">
          <strong>
            Fix {issues.length} thing{issues.length > 1 ? 's' : ''} before verifying
          </strong>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>
                <a
                  href={`#${ISSUE_TEXT[issue].field}`}
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById(ISSUE_TEXT[issue].field)?.focus();
                  }}
                >
                  {ISSUE_TEXT[issue].text}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="pp-dish-editor__error">
          {error}
        </p>
      )}

      <div className="pp-dish-editor__grid">
        <section className="pp-dish-editor__fields" aria-label="Dish details">
          <TextField
            id="dish-name"
            label="Dish name"
            value={value.name}
            onChange={(event) => set({ name: event.target.value })}
            error={issueFor('name') ?? issueFor('rejected') ?? ''}
          />
          <TextField
            id="dish-category"
            label="Category"
            value={value.category}
            onChange={(event) => set({ category: event.target.value })}
            error={issueFor('category') ?? ''}
            hint={check('category', 'Not read from the menu. Check it.') ?? ''}
          />
          <TextField
            id="dish-price"
            label="Price"
            inputMode="decimal"
            value={value.priceAmount}
            onChange={(event) => set({ priceAmount: event.target.value })}
            error={issueFor('price') ?? ''}
            hint={
              value.source?.priceText
                ? `Printed on the menu: ${value.source.priceText}`
                : (check('price_amount', 'Not read from the menu. Check it.') ?? '')
            }
          />
          <TextField
            id="dish-currency"
            label="Currency"
            maxLength={3}
            value={value.priceCurrency}
            onChange={(event) => set({ priceCurrency: event.target.value.toUpperCase() })}
            error={issueFor('currency') ?? ''}
          />
          <div className="pp-field">
            <label className="pp-field__label" htmlFor="dish-description">
              Description
            </label>
            <textarea
              id="dish-description"
              className="pp-input pp-field__control"
              rows={4}
              value={value.description}
              onChange={(event) => set({ description: event.target.value })}
            />
            {uncertain.has('description') && (
              <p className="pp-field__hint">Not read from the menu. Add one if you like.</p>
            )}
          </div>

          <fieldset className="pp-dish-editor__group">
            <legend>Ingredients</legend>
            {extracted ? (
              <p className="pp-field__hint">
                Read from the menu, so they stay a draft until you verify the dish.
              </p>
            ) : (
              <StatusChoice
                name="ingredients-status"
                value={value.ingredients.status}
                onChange={(status) =>
                  set({
                    ingredients: {
                      status,
                      items: status === 'unknown' ? [] : value.ingredients.items,
                    },
                  })
                }
              />
            )}
            <ul className="pp-dish-editor__tags" aria-label="Ingredients">
              {value.ingredients.items.map((item) => (
                <li key={item}>
                  {item}{' '}
                  <button
                    type="button"
                    aria-label={`Remove ${item}`}
                    onClick={() => {
                      const items = value.ingredients.items.filter((x) => x !== item);
                      set({
                        ingredients: {
                          status: items.length === 0 ? 'unknown' : value.ingredients.status,
                          items,
                        },
                      });
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="pp-dish-editor__row">
              <input
                className="pp-input"
                aria-label="Add an ingredient"
                placeholder="Add an ingredient"
                value={ingredient}
                onChange={(event) => setIngredient(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addIngredient();
                  }
                }}
              />
              <Button variant="outline" onClick={addIngredient}>
                Add
              </Button>
            </div>
          </fieldset>

          <fieldset className="pp-dish-editor__group">
            <legend>Allergens</legend>
            {extracted ? (
              <p className="pp-field__hint">
                Allergens are not read from menus and cannot be saved on a scanned dish yet. Until
                they are added and confirmed, diners see: “{STAFF_ALLERGY_LINE}”
              </p>
            ) : (
              <>
                <StatusChoice
                  name="allergens-status"
                  value={value.allergens.status}
                  onChange={(status) =>
                    set({
                      allergens: {
                        status,
                        items: status === 'unknown' ? [] : value.allergens.items,
                      },
                    })
                  }
                />
                <div className="pp-dish-editor__checks">
                  {ALLERGEN_CODES.map((code) => (
                    <label key={code}>
                      <input
                        type="checkbox"
                        disabled={value.allergens.status === 'unknown'}
                        checked={value.allergens.items.includes(code)}
                        onChange={(event) =>
                          set({
                            allergens: {
                              status: value.allergens.status,
                              items: event.target.checked
                                ? [...value.allergens.items, code]
                                : value.allergens.items.filter((x) => x !== code),
                            },
                          })
                        }
                      />{' '}
                      {ALLERGEN_LABEL(code)}
                    </label>
                  ))}
                </div>
              </>
            )}
            <p className="pp-field__hint" aria-live="polite">
              Diners will see: {allergens.label}. {STAFF_ALLERGY_LINE}
            </p>
          </fieldset>
        </section>

        {extracted && (
          <aside className="pp-dish-editor__evidence" aria-label="From the menu">
            <h2>From the menu</h2>
            {evidence.length === 0 ? (
              <p className="pp-field__hint">No source text was kept for this dish.</p>
            ) : (
              evidence.map((excerpt) => (
                <figure key={`${excerpt.segmentId}-${excerpt.text.slice(0, 24)}`}>
                  <figcaption>Page {excerpt.page ?? '?'}</figcaption>
                  <pre>{excerpt.text}</pre>
                </figure>
              ))
            )}
          </aside>
        )}
      </div>

      <div className="pp-dish-editor__row">
        <Button variant="outline" onClick={onSave} disabled={busy}>
          Save draft
        </Button>
        {onVerify && (
          <Button type="submit" disabled={busy}>
            Verify dish
          </Button>
        )}
        <Button variant="text" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      <p className="pp-field__hint">Verifying a dish does not publish your menu.</p>
    </form>
  );
}

function StatusChoice({
  name,
  value,
  onChange,
}: {
  name: string;
  value: ValueStatus;
  onChange: (status: ValueStatus) => void;
}) {
  return (
    <div className="pp-dish-editor__status" role="radiogroup" aria-label="Status">
      {(['unknown', 'proposed', 'confirmed'] as const).map((status) => (
        <label key={status}>
          <input
            type="radio"
            name={name}
            checked={value === status}
            onChange={() => onChange(status)}
          />{' '}
          {STATUS_LABEL[status]}
        </label>
      ))}
    </div>
  );
}
