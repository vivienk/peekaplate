// Live values and evidence on #172's authored Screen 9; demo providers stay in menu.tsx.

import { PublicMenuAllergenCodeSchema, parseServingCountInput } from '@peekaplate/contracts';
import { type ReactNode, useState } from 'react';
import { DishFormView } from '../owner-dashboard/DishFormView';
import type { MenuItem } from '../owner-dashboard/data';
import {
  allergenOutcome,
  type DishForm,
  invalidateChangedCalibration,
  pilotPriceCurrency,
  STAFF_ALLERGY_LINE,
} from './dishForm';
import type { EvidenceExcerpt } from './evidence';
import { PortionCalibrationEditor } from './PortionCalibrationEditor';
import type { CalibrationPhoto } from './portionCalibration';
import { servingCountText } from './servingCount';
import './dishEditor.css';

export type DishEditorProps = {
  value: DishForm;
  photo?: ReactNode;
  photoUrl?: string | null;
  calibrationPhoto?: CalibrationPhoto;
  photoPending?: boolean;
  calibrationPhotoUnavailable?: boolean;
  /** Private generated portion preview; never grants publication authority. */
  portionReview?: {
    status: 'processing' | 'needs_review' | 'failed';
    previewUrl?: string;
    message?: string;
    approved?: boolean;
  };
  onApprovePortion?: () => void;
  onGeneratePortion?: () => void;
  existing?: boolean;
  categories?: string[];
  onAddCategory?: (category: string) => void;
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
  suggestIngredients?: (name: string) => Promise<string[]>;
  suggestAllergens?: (name: string, ingredients: string[]) => Promise<string[]>;
  draftDescription?: (name: string, ingredients: string[]) => Promise<string>;
};

export function DishEditor({
  value,
  photo,
  photoUrl,
  calibrationPhoto,
  photoPending = false,
  calibrationPhotoUnavailable = false,
  portionReview,
  onApprovePortion,
  onGeneratePortion,
  existing = false,
  categories = [],
  onAddCategory,
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
  suggestIngredients,
  suggestAllergens,
  draftDescription,
}: DishEditorProps) {
  const [fieldError, setFieldError] = useState('');
  const change = (next: DishForm) => onChange(invalidateChangedCalibration(value, next));
  const measuredPhoto =
    !photoPending && calibrationPhoto?.photoId === value.photoId ? calibrationPhoto : undefined;
  const countText =
    value.servingCount ?? servingCountText(undefined, value.servingSize, value.portionCalibration);
  const countError = parseServingCountInput(countText) === undefined;
  const menu: MenuItem = {
    id: existing ? (value.source?.candidateId ?? 'saved-draft') : null,
    name: value.name,
    cat: value.category,
    price: value.priceAmount,
    size: countText,
    desc: value.description,
    ing: value.ingredients.items,
    alg: value.allergens.items,
    aiIng: value.aiIng ?? [],
    aiAlg: value.aiAlg ?? [],
    // The owner draft contract has no dietary field yet, so saved dishes start empty.
    diet: [],
    upload: photoUrl ?? (value.photoId ? 'private-photo' : null),
    rights: licenseConfirmed,
    aiUsed: value.aiUsed || value.origin === 'extracted',
    aiReviewed: reviewConfirmed,
    has25: false,
    status: 'draft',
    photoId: value.photoId,
  };
  const allergy = allergenOutcome(value);
  return (
    <div className="owner-menu-design">
      <DishFormView
        descriptionActionLabel="Shorten description with AI"
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
          if (dish.aiReviewed !== reviewConfirmed && dish.aiReviewed) {
            // Ticking the review box confirms what the owner reviewed: AI ingredients and,
            // when AI suggested any, the allergens list shown above it.
            const confirmAllergens = (value.aiAlg ?? []).length > 0;
            if (value.ingredients.items.length || confirmAllergens)
              change({
                ...value,
                ...(value.ingredients.items.length && {
                  aiIng: [],
                  ingredients: { ...value.ingredients, status: 'confirmed' as const },
                }),
                ...(confirmAllergens && {
                  aiAlg: [],
                  allergens: { ...value.allergens, status: 'confirmed' as const },
                }),
              });
            onReviewConfirmedChange?.(dish.aiReviewed);
            return;
          }
          if (dish.rights !== licenseConfirmed) {
            onLicenseConfirmedChange?.(dish.rights);
            return;
          }
          const aiIng = dish.aiIng.filter((item) => dish.ing.includes(item));
          const aiAlg = dish.aiAlg.filter((item) => dish.alg.includes(item));
          change({
            ...value,
            name: dish.name,
            category: dish.cat,
            description: dish.desc,
            priceAmount: String(dish.price),
            // One visible people field writes both the canonical count and legacy count text.
            // Unrelated edits keep any old descriptive serving text unchanged.
            ...(dish.size !== countText ? { servingSize: dish.size, servingCount: dish.size } : {}),
            aiIng,
            aiAlg,
            aiUsed: dish.aiUsed,
            ingredients: aiIng.length
              ? { status: 'proposed', items: dish.ing }
              : JSON.stringify(dish.ing) === JSON.stringify(value.ingredients.items)
                ? value.ingredients
                : { status: dish.ing.length ? 'confirmed' : 'unknown', items: dish.ing },
            allergens: aiAlg.length
              ? { status: 'proposed', items: parsed.data }
              : JSON.stringify(dish.alg) === JSON.stringify(value.allergens.items)
                ? value.allergens
                : { status: dish.alg.length ? 'confirmed' : 'unknown', items: parsed.data },
          });
          if (dish.aiReviewed !== reviewConfirmed) onReviewConfirmedChange?.(dish.aiReviewed);
        }}
        {...(suggestIngredients && { suggestIngredients })}
        {...(suggestAllergens && { suggestAllergens })}
        {...(draftDescription && { draftDescription })}
        categories={categories}
        {...(onAddCategory && { onAddCategory })}
        {...(portionReview ? { portionReview } : {})}
        {...(onApprovePortion ? { onApprovePortion } : {})}
        {...(onGeneratePortion ? { onGeneratePortion } : {})}
        portionCalibrationControl={
          <PortionCalibrationEditor
            key={
              measuredPhoto ? `${measuredPhoto.photoId}:${measuredPhoto.source_sha256}` : 'no-photo'
            }
            value={value.portionCalibration}
            photo={measuredPhoto}
            photoPending={photoPending}
            photoUnavailable={calibrationPhotoUnavailable}
            busy={busy}
            onChange={(portionCalibration) => change({ ...value, portionCalibration })}
          />
        }
        imageFor={() => photoUrl ?? (value.photoId ? 'private-photo' : null)}
        onSelectPhoto={() => {}}
        photo={photo}
        currency={pilotPriceCurrency(value.priceCurrency)}
        allowZeroPrice
        requireReviewBox={Boolean(onReviewConfirmedChange)}
        busy={busy}
        error={error || fieldError}
        sourceNote={
          <>
            {value.source?.priceText && <p>Printed on the menu: {value.source.priceText}</p>}
            {value.source?.currencyDefaulted && (
              <p role="status">
                Currency was not read from the menu. Prices use the USD pilot default.
              </p>
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
