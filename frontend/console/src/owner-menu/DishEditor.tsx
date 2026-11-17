// Live values and evidence on #172's authored Screen 9; demo providers stay in menu.tsx.

import { PublicMenuAllergenCodeSchema } from '@peekaplate/contracts';
import { type ReactNode, useState } from 'react';
import { TextField } from '../foundations/TextField';
import { DishFormView } from '../owner-dashboard/DishFormView';
import type { MenuItem } from '../owner-dashboard/data';
import { allergenOutcome, type DishForm, STAFF_ALLERGY_LINE } from './dishForm';
import type { EvidenceExcerpt } from './evidence';
import './dishEditor.css';

export type DishEditorProps = {
  value: DishForm;
  photo?: ReactNode;
  photoUrl?: string | null;
  existing?: boolean;
  categories?: string[];
  onChange: (next: DishForm) => void;
  onSave: () => void;
  onVerify?: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  evidence?: readonly EvidenceExcerpt[];
  saveLabel?: string;
  cancelLabel?: string;
  reviewConfirmed?: boolean;
  onReviewConfirmedChange?: (confirmed: boolean) => void;
  licenseConfirmed?: boolean;
  onLicenseConfirmedChange?: (confirmed: boolean) => void;
};

export function DishEditor({
  value,
  photo,
  photoUrl,
  existing = false,
  categories = [],
  onChange,
  onSave,
  onCancel,
  busy = false,
  error,
  evidence = [],
  reviewConfirmed = false,
  onReviewConfirmedChange,
  licenseConfirmed = false,
  onLicenseConfirmedChange,
}: DishEditorProps) {
  const [fieldError, setFieldError] = useState('');
  const countText = value.servingCount?.trim() ?? '';
  const countError =
    countText && !/^(?:[1-9]\d?|100)$/.test(countText)
      ? 'Enter a whole number from 1 to 100, or leave blank if unknown.'
      : '';
  const [repairCurrency] = useState(() => !value.priceCurrency);
  const menu: MenuItem = {
    id: existing ? (value.source?.candidateId ?? 'saved-draft') : null,
    name: value.name,
    cat: value.category,
    price: value.priceAmount,
    size: value.servingSize,
    desc: value.description,
    ing: value.ingredients.items,
    alg: value.allergens.items,
    aiIng: [],
    aiAlg: [],
    upload: photoUrl ?? (value.photoId ? 'private-photo' : null),
    rights: licenseConfirmed,
    aiUsed: value.origin === 'extracted',
    aiReviewed: reviewConfirmed,
    has25: false,
    status: 'draft',
    photoId: value.photoId,
  };
  const allergy = allergenOutcome(value);
  return (
    <div className="owner-menu-design">
      <DishFormView
        ed={{ step: 'form', draft: menu, origId: menu.id }}
        orig={menu.id ? menu : null}
        setEd={(next) => {
          if (busy || (next.step !== 'form' && next.step !== 'review')) return;
          const dish = next.draft;
          const parsed = PublicMenuAllergenCodeSchema.array().safeParse(dish.alg);
          if (!parsed.success) {
            setFieldError(
              'Use a supported allergen: milk, egg, fish, crustacean shellfish, nuts, peanut, wheat, soy or sesame. Do not infer allergens from ingredients.',
            );
            return;
          }
          setFieldError('');
          if (dish.aiReviewed !== reviewConfirmed) {
            if (dish.aiReviewed && value.ingredients.items.length)
              onChange({ ...value, ingredients: { ...value.ingredients, status: 'confirmed' } });
            onReviewConfirmedChange?.(dish.aiReviewed);
            return;
          }
          if (dish.rights !== licenseConfirmed) {
            onLicenseConfirmedChange?.(dish.rights);
            return;
          }
          onChange({
            ...value,
            name: dish.name,
            category: dish.cat,
            description: dish.desc,
            priceAmount: String(dish.price),
            servingSize: dish.size,
            ingredients:
              JSON.stringify(dish.ing) === JSON.stringify(value.ingredients.items)
                ? value.ingredients
                : { status: dish.ing.length ? 'confirmed' : 'unknown', items: dish.ing },
            allergens:
              JSON.stringify(dish.alg) === JSON.stringify(value.allergens.items)
                ? value.allergens
                : { status: dish.alg.length ? 'confirmed' : 'unknown', items: parsed.data },
          });
        }}
        categories={categories}
        servingCountControl={
          <TextField
            id="dish-serving-count"
            label="People served"
            type="number"
            min={1}
            max={100}
            step={1}
            value={value.servingCount ?? ''}
            error={countError}
            hint="Optional. Actual-size AR also needs confirmed plate measurements for this count; this number never scales the dish."
            onChange={(event) => onChange({ ...value, servingCount: event.target.value })}
          />
        }
        imageFor={() => photoUrl ?? (value.photoId ? 'private-photo' : null)}
        onSelectPhoto={() => {}}
        photo={photo}
        currency={value.priceCurrency || 'currency not set'}
        allowZeroPrice
        requireReviewBox={Boolean(onReviewConfirmedChange)}
        busy={busy}
        error={error || fieldError}
        sourceNote={
          <>
            {value.source?.priceText && <p>Printed on the menu: {value.source.priceText}</p>}
            {!value.priceCurrency && (
              <p role="status">
                The source has no currency. Enter the printed three-letter currency; do not infer it
                from a price symbol.
              </p>
            )}
            {repairCurrency && (
              <TextField
                id="dish-currency"
                label="Currency code"
                maxLength={3}
                value={value.priceCurrency}
                onChange={(event) =>
                  onChange({ ...value, priceCurrency: event.target.value.toUpperCase() })
                }
              />
            )}
            <p className="pp-field__hint">
              Diners will see: {allergy.label}. {STAFF_ALLERGY_LINE}
            </p>
          </>
        }
        evidence={
          value.origin === 'extracted' && (
            <aside aria-label="From the menu" className="pp-dish-editor__evidence">
              <h2>From the menu</h2>
              {evidence.length ? (
                evidence.map((excerpt) => (
                  <figure key={excerpt.segmentId}>
                    <figcaption>Page {excerpt.page ?? '?'}</figcaption>
                    <pre>{excerpt.text}</pre>
                  </figure>
                ))
              ) : (
                <p>No source text was kept for this dish.</p>
              )}
            </aside>
          )
        }
        cancel={onCancel}
        toReview={() => {
          if (busy || fieldError || countError || (onLicenseConfirmedChange && !licenseConfirmed))
            return;
          onSave();
        }}
      />
    </div>
  );
}
