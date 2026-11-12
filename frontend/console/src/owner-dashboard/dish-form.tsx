// Reusable Add/Edit Dish form (owner Screen 9). It holds no data of its own: the dish comes in as
// `value`, every edit goes out through `onChange`, and `onSave` runs only after the checks pass.
// The demo passes sample data; FE-06.2 passes a saved or OCR draft and saves through the draft API.
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import {
  ALLERGEN_LABEL,
  ALLERGENS,
  allergenSummary,
  type DishFields,
  type FieldError,
  toggleAllergen,
  validateDish,
  withAllergenStatus,
} from './dish-fields';
import { Btn, Icon } from './ui';

export interface DishFormProps {
  value: DishFields;
  onChange: (next: DishFields) => void;
  /** Runs after the checks pass, with the current value ("Review changes"). */
  onSave: (value: DishFields) => void;
  onCancel: () => void;
  /** Optional "Save draft" button. Skips the checks, because drafts may be incomplete. */
  onSaveDraft?: (value: DishFields) => void;
  mode: 'add' | 'edit';
  /** Heading. Defaults to the dish name, or "New dish". */
  title?: string;
  categories: readonly string[];
  /** Preview of the current photo (a data URL, or the draft API photo URL). */
  photoUrl?: string | null;
  /** Called with the chosen file. Leave it out to hide the upload button. */
  onPhotoSelect?: (file: File) => void;
  /** #105 requires a photo before review. Defaults to true. */
  requirePhoto?: boolean;
  /** True while the caller is saving: buttons are disabled. */
  saving?: boolean;
  /** A save or load error to show above the form. */
  error?: string | null;
  /** Extra checks run with the built-in ones (for example the demo's photo rights). */
  validate?: (value: DishFields) => FieldError[];
  /** Optional slots, for example the demo's AI and 2.5D parts. */
  slots?: {
    notice?: ReactNode;
    descriptionTools?: ReactNode;
    ingredientTools?: ReactNode;
    /** A small badge after an ingredient, for example "AI". */
    ingredientBadge?: (item: string) => ReactNode;
    afterFields?: ReactNode;
    afterPhoto?: ReactNode;
    side?: ReactNode;
  };
}

const inputStyle = {
  flex: '1 1 160px',
  border: '1.5px solid var(--line2)',
  borderRadius: 12,
  padding: '10px 12px',
  minHeight: 44,
  background: 'var(--surface)',
} as const;

export function DishForm({
  value: v,
  onChange,
  onSave,
  onCancel,
  onSaveDraft,
  mode,
  title,
  categories,
  photoUrl,
  onPhotoSelect,
  requirePhoto = true,
  saving = false,
  error,
  validate,
  slots = {},
}: DishFormProps) {
  const [errs, setErrs] = useState<FieldError[]>([]);
  const [tag, setTag] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<DishFields>) => onChange({ ...v, ...p });
  const ing = v.ingredients;
  const setIng = (items: string[]) =>
    set({
      ingredients: {
        items,
        // Typing a first ingredient is the owner's own fact; an empty list is unknown again.
        status:
          items.length === 0 ? 'unknown' : ing.status === 'unknown' ? 'confirmed' : ing.status,
      },
    });
  const addTag = () => {
    const t = tag.trim();
    if (!t || ing.items.includes(t)) return;
    setIng([...ing.items, t]);
    setTag('');
  };
  const hasPhoto = Boolean(photoUrl || v.photoId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const er = [...validateDish(v, { hasPhoto, requirePhoto }), ...(validate?.(v) ?? [])];
    setErrs(er);
    if (er.length) {
      setTimeout(() => document.getElementById('errsum')?.focus(), 0);
      return;
    }
    onSave(v);
  };
  const err = (id: string) => errs.find((x) => x[0] === id)?.[1];
  const options =
    v.category && !categories.includes(v.category) ? [v.category, ...categories] : categories;
  const alg = v.allergens;
  return (
    <form className="stack" onSubmit={submit} noValidate aria-busy={saving}>
      <div>
        <Btn kind="text" icon="back" type="button" onClick={onCancel}>
          Back to Menu
        </Btn>
      </div>
      <div className="pagehead">
        <span className="eyebrow">{mode === 'edit' ? 'Edit dish' : 'Add dish'} · Step 1 of 3</span>
        <h1>{title || v.name || 'New dish'}</h1>
        {slots.notice}
      </div>
      {error && (
        <div role="alert" className="note coral">
          <Icon n="warn" s={18} />
          <div>{error}</div>
        </div>
      )}
      {errs.length > 0 && (
        <div id="errsum" tabIndex={-1} role="alert" className="note coral">
          <Icon n="warn" s={18} />
          <div>
            <b>
              Fix {errs.length} thing{errs.length > 1 ? 's' : ''} before reviewing
            </b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {errs.map(([id, m]) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(id)?.focus();
                    }}
                    style={{ color: 'inherit' }}
                  >
                    {m}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="formgrid">
        <section className="card stack">
          <div className="field">
            <label htmlFor="f-name">Dish name</label>
            <input
              id="f-name"
              type="text"
              value={v.name ?? ''}
              aria-invalid={!!err('f-name')}
              onChange={(e) => set({ name: e.target.value })}
            />
            {err('f-name') && <span className="err">{err('f-name')}</span>}
          </div>
          <div className="grid g2">
            <div className="field">
              <label htmlFor="f-cat">Category</label>
              <select
                id="f-cat"
                value={v.category ?? ''}
                aria-invalid={!!err('f-cat')}
                onChange={(e) => set({ category: e.target.value || null })}
              >
                {!v.category && <option value="">Choose a category</option>}
                {options.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              {err('f-cat') && <span className="err">{err('f-cat')}</span>}
            </div>
            <div className="field">
              <label htmlFor="f-price">Price ({v.priceCurrency || 'USD'})</label>
              <input
                id="f-price"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={v.priceAmount ?? ''}
                aria-invalid={!!err('f-price')}
                onChange={(e) => set({ priceAmount: e.target.value || null })}
              />
              {err('f-price') && <span className="err">{err('f-price')}</span>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="f-desc">Description</label>
            <textarea
              id="f-desc"
              rows={4}
              value={v.description ?? ''}
              aria-invalid={!!err('f-desc')}
              onChange={(e) => set({ description: e.target.value || null })}
            />
            {err('f-desc') && <span className="err">{err('f-desc')}</span>}
            {slots.descriptionTools}
          </div>
          <div className="field">
            <span className="fl" id="f-ing-l">
              Ingredients
            </span>
            {ing.status === 'unknown' && (
              <span className="hint">Not checked yet. Add the ingredients you know.</span>
            )}
            <div className="tags" aria-labelledby="f-ing-l">
              {ing.items.map((t) => (
                <span key={t} className={`tag${ing.status === 'proposed' ? ' ai' : ''}`}>
                  {t}
                  {slots.ingredientBadge?.(t)}
                  <button
                    type="button"
                    aria-label={`Remove ${t}`}
                    onClick={() => setIng(ing.items.filter((x) => x !== t))}
                  >
                    <Icon n="x" s={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="row">
              <input
                id="f-ing"
                type="text"
                aria-label="Add an ingredient"
                placeholder="Add an ingredient"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                style={inputStyle}
                aria-invalid={!!err('f-ing')}
              />
              <Btn kind="outlined" size="md" type="button" onClick={addTag}>
                Add
              </Btn>
              {slots.ingredientTools}
            </div>
            {err('f-ing') && <span className="err">{err('f-ing')}</span>}
            {ing.status !== 'unknown' && (
              <label className="check" htmlFor="f-ing-ok">
                <input
                  id="f-ing-ok"
                  type="checkbox"
                  checked={ing.status === 'confirmed'}
                  onChange={(e) =>
                    set({
                      ingredients: { ...ing, status: e.target.checked ? 'confirmed' : 'proposed' },
                    })
                  }
                />
                <span>
                  I checked these ingredients. They are accurate.
                  {err('f-ing-ok') && (
                    <span className="err" style={{ display: 'block' }}>
                      {err('f-ing-ok')}
                    </span>
                  )}
                </span>
              </label>
            )}
            <span className="hint">Ingredients are hidden from diners until you approve them.</span>
          </div>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="fl">Allergens</legend>
            <label className="check" htmlFor="f-alg-unknown">
              <input
                id="f-alg-unknown"
                type="radio"
                name="f-alg"
                checked={alg.status === 'unknown'}
                onChange={() => onChange(withAllergenStatus(v, 'unknown'))}
              />
              <span>Not checked yet. Diners are told to ask staff.</span>
            </label>
            {alg.status === 'proposed' && (
              <label className="check" htmlFor="f-alg-proposed">
                <input id="f-alg-proposed" type="radio" name="f-alg" checked readOnly />
                <span>Suggested from your menu file. Check them below.</span>
              </label>
            )}
            <label className="check" htmlFor="f-alg-confirmed">
              <input
                id="f-alg-confirmed"
                type="radio"
                name="f-alg"
                checked={alg.status === 'confirmed'}
                onChange={() => onChange(withAllergenStatus(v, 'confirmed'))}
              />
              <span>I checked. It contains the allergens ticked below.</span>
            </label>
            {alg.status !== 'unknown' && (
              <div className="tags">
                {ALLERGENS.map((code) => (
                  <label key={code} className="check" htmlFor={`f-alg-${code}`}>
                    <input
                      id={`f-alg-${code}`}
                      type="checkbox"
                      checked={alg.items.includes(code)}
                      onChange={(e) => onChange(toggleAllergen(v, code, e.target.checked))}
                    />
                    <span>{ALLERGEN_LABEL[code]}</span>
                  </label>
                ))}
              </div>
            )}
            {err('f-alg-unknown') && <span className="err">{err('f-alg-unknown')}</span>}
            <span className="hint" aria-live="polite">
              Diners will see: {allergenSummary(alg)}
            </span>
          </fieldset>
          {slots.afterFields}
        </section>
        <div className="stack">
          <section className="card stack">
            <h3>Photo</h3>
            <div className="dcard" style={{ background: 'var(--surface2)' }}>
              {photoUrl ? (
                <img
                  src={photoUrl}
                  alt={v.name ? `${v.name} photo` : 'Dish photo'}
                  style={{ width: 140, height: 140, objectFit: 'contain' }}
                />
              ) : (
                <span className="muted">No photo yet</span>
              )}
            </div>
            {onPhotoSelect && (
              <>
                <input
                  ref={fileRef}
                  id="f-photo"
                  type="file"
                  accept="image/jpeg,image/png"
                  className="sr"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onPhotoSelect(f);
                  }}
                />
                <Btn
                  kind="outlined"
                  size="lg"
                  type="button"
                  disabled={saving}
                  onClick={() => fileRef.current?.click()}
                >
                  {hasPhoto ? 'Replace photo' : 'Upload photo'}
                </Btn>
              </>
            )}
            {err('f-photo') && (
              <span className="err" id="f-photo-e">
                {err('f-photo')}
              </span>
            )}
            {slots.afterPhoto}
          </section>
          {slots.side}
        </div>
      </div>
      <div className="row">
        <Btn kind="primary" size="lg" type="submit" disabled={saving}>
          Review changes
        </Btn>
        {onSaveDraft && (
          <Btn
            kind="outlined"
            size="lg"
            type="button"
            disabled={saving}
            onClick={() => onSaveDraft(v)}
          >
            Save draft
          </Btn>
        )}
        <Btn kind="outlined" size="lg" type="button" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </form>
  );
}
