// S09 presentation extracted from #172, with the same authored markup and tokens.
// Demo fixtures/providers are supplied by menu.tsx; the signed-in adapter supplies persisted data.
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { TextField } from '../foundations/TextField';
import { CategoryField } from './category-field';
import { Btn, Icon } from './controls';
import type { MenuItem } from './data';
import type { EditState } from './menu';
import { DishFormFrame } from './menu-presentation';

export const priceInput = (raw: string) => {
  const [whole = '', ...rest] = raw.replace(/[^\d.]/g, '').split('.');
  return rest.length ? `${whole}.${rest.join('').slice(0, 2)}` : whole;
};

export function DishFormView({
  ed,
  setEd,
  orig,
  cancel,
  toReview,
  requireReviewBox = false,
  categories,
  imageFor,
  onSelectPhoto,
  suggestIngredients,
  suggestAllergens,
  draftDescription,
  descriptionActionLabel = 'Draft with AI',
  currency = 'USD',
  allowZeroPrice = false,
  busy = false,
  error,
  sourceNote,
  evidence,
  photo,
  servingCountControl,
  portionReview,
  onApprovePortion,
  onGeneratePortion,
}: {
  ed: Extract<EditState, { step: 'form' | 'review' }>;
  setEd: (e: EditState) => void;
  orig: MenuItem | null;
  cancel: () => void;
  toReview: () => void;
  /** Onboarding (S9 -> S10): "I reviewed the AI-drafted text and ingredients" must always be ticked. */
  requireReviewBox?: boolean;
  categories: readonly string[];
  imageFor: (dish: MenuItem) => string | null | undefined;
  onSelectPhoto: (file: File) => void;
  suggestIngredients?: (name: string) => Promise<string[]>;
  suggestAllergens?: (name: string, ingredients: string[]) => Promise<string[]>;
  draftDescription?: (name: string, ingredients: string[]) => Promise<string>;
  descriptionActionLabel?: string;
  currency?: string;
  allowZeroPrice?: boolean;
  busy?: boolean;
  error?: string | null;
  sourceNote?: ReactNode;
  evidence?: ReactNode;
  photo?: ReactNode;
  servingCountControl?: ReactNode;
  /** Private owner-only preview, never public publication evidence. */
  portionReview?: {
    status: 'processing' | 'needs_review' | 'failed';
    previewUrl?: string;
    message?: string;
    approved?: boolean;
  };
  onApprovePortion?: () => void;
  onGeneratePortion?: () => void;
}) {
  const dr = ed.draft;
  const latest = useRef(ed);
  latest.current = ed;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stillCurrent = () => mounted.current && latest.current === ed;
  const [errs, setErrs] = useState<Record<string, string>>({});
  // Categories offered in the Category field: the demo's, plus the dish's own and any the owner adds.
  const [cats, setCats] = useState<string[]>(() =>
    dr.cat && !categories.includes(dr.cat) ? [...categories, dr.cat] : [...categories],
  );
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const [ingText, setIngText] = useState('');
  const [algText, setAlgText] = useState('');
  const [suggestionError, setSuggestionError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<MenuItem>) => setEd({ ...ed, draft: { ...dr, ...p } });
  // Any AI suggestion needs a fresh review.
  const setAi = (p: Partial<MenuItem>) => set({ ...p, aiUsed: true, aiReviewed: false });
  const check = (d: MenuItem) => {
    const er: Record<string, string> = {};
    if (d.name.trim().length < 2) er['f-name'] = 'Enter a dish name';
    if (!d.cat) er['f-cat'] = 'Select a category';
    if (
      !/^\d+(\.\d{1,2})?$/.test(String(d.price).trim()) ||
      !(allowZeroPrice ? Number(d.price) >= 0 : Number(d.price) > 0)
    )
      er['f-price'] = 'Enter a valid price';
    if (!d.size.trim()) er['f-size'] = 'Enter a serving size';
    if (d.ing.length < 1) er['f-ing'] = 'Add at least one ingredient';
    // A photo is required (Jeffin, 14 Nov): an uploaded one or the dish's existing photo.
    if (!imageFor(d)) er['f-photo'] = 'Add a photo of the dish';
    if (d.upload && !d.rights) er['f-rights'] = 'Confirm you have the right to use this photo';
    if ((requireReviewBox || d.aiUsed) && !d.aiReviewed)
      er['f-ai'] = 'Confirm you reviewed the AI-drafted text and ingredients';
    return er;
  };
  const ready = Object.keys(check(dr)).length === 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // The review box is required first: Enter in a field cannot skip it.
    if (requireReviewBox && !dr.aiReviewed) {
      setErrs(check(dr));
      document.getElementById('f-ai')?.focus();
      return;
    }
    const er = check(dr);
    setErrs(er);
    const first = Object.keys(er)[0];
    if (first) {
      setTimeout(() => {
        document.getElementById('errsum')?.scrollIntoView({ block: 'center' });
        document.getElementById(first)?.focus();
      }, 0);
      return;
    }
    toReview();
  };
  // Errors clear as the owner fixes each field.
  const err = (id: string) => (errs[id] && check(dr)[id] ? errs[id] : undefined);
  const showErrs = Object.keys(errs).some((id) => err(id));
  // TextField takes error only when there is one.
  const errOf = (id: string) => {
    const e = err(id);
    return e ? { error: e } : {};
  };
  // Same error line as TextField, for the fields TextField cannot hold (select, checkbox).
  const fieldErr = (id: string) =>
    err(id) && (
      <p className="pp-field__error" id={`${id}-error`}>
        <span className="pp-visually-hidden">Error: </span>
        {err(id)}
      </p>
    );
  const addTo = (key: 'ing' | 'alg', text: string, clear: () => void) => {
    const t = text.trim();
    if (!t || dr[key].some((x) => x.toLowerCase() === t.toLowerCase())) return;
    set({ [key]: [...dr[key], t] });
    clear();
  };
  const onEnter = (add: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  };
  // Tag 2324:15403; AI suggestions keep the dashed "AI" tag until the owner reviews them.
  const tags = (label: string, items: string[], aiItems: string[], remove: (t: string) => void) =>
    items.length > 0 && (
      <ul className="tags" aria-label={label}>
        {items.map((t) => {
          const ai = aiItems.includes(t);
          return (
            <li key={t} className={`tag${ai ? ' ai' : ''}`}>
              {t}
              {ai && (
                <span className="ai-mark" title="Suggested by AI">
                  AI
                </span>
              )}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => remove(t)}>
                <Icon n="x" s={12} />
              </button>
            </li>
          );
        })}
      </ul>
    );
  const addIng = () => addTo('ing', ingText, () => setIngText(''));
  const addAlg = () => addTo('alg', algText, () => setAlgText(''));
  return (
    <form className="s09" onSubmit={submit} noValidate aria-busy={busy}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <DishFormFrame
          title={orig ? 'Edit dish' : 'Add dish'}
          aside={
            <>
              <section className="card s09-sidecard" aria-labelledby="s09-photo">
                <h2 id="s09-photo" className="s09-req">
                  Photo<span className="pp-visually-hidden"> (required)</span>
                </h2>
                {photo ?? (
                  <>
                    <div className={`s09-photo${imageFor(dr) ? ' has' : ''}`}>
                      {imageFor(dr) ? (
                        <img
                          src={imageFor(dr) ?? undefined}
                          alt={dr.name ? `${dr.name} photo` : 'Dish photo'}
                        />
                      ) : (
                        <span>No photo yet</span>
                      )}
                    </div>
                    <input
                      ref={fileRef}
                      id="f-photo-file"
                      type="file"
                      accept="image/jpeg,image/png"
                      className="sr"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onSelectPhoto(f);
                      }}
                    />
                    <Btn
                      id="f-photo"
                      kind="outlined"
                      size="md"
                      type="button"
                      aria-describedby={err('f-photo') ? 'f-photo-error' : undefined}
                      onClick={() => fileRef.current?.click()}
                    >
                      {imageFor(dr) ? 'Replace photo' : 'Upload photo'}
                    </Btn>
                  </>
                )}
                {fieldErr('f-photo')}
                {dr.upload && (
                  <div className="pp-field">
                    <label className="s09-check" htmlFor="f-rights">
                      <input
                        id="f-rights"
                        type="checkbox"
                        checked={dr.rights}
                        aria-invalid={err('f-rights') ? true : undefined}
                        aria-describedby={err('f-rights') ? 'f-rights-error' : undefined}
                        onChange={(e) => set({ rights: e.target.checked })}
                      />
                      <span>I have the right to use this photo.</span>
                    </label>
                    {fieldErr('f-rights')}
                  </div>
                )}
              </section>
              <section className="card s09-sidecard s09-sidecard--25d" aria-labelledby="s09-25d">
                <h2 id="s09-25d">2.5D preview</h2>
                {onGeneratePortion && !portionReview?.approved && (
                  <Btn
                    kind="outlined"
                    size="md"
                    type="button"
                    disabled={busy || !dr.upload}
                    onClick={onGeneratePortion}
                  >
                    Save photo and generate 2.5D
                  </Btn>
                )}
                {portionReview?.status === 'needs_review' && portionReview.previewUrl ? (
                  <>
                    <div className="s09-photo has">
                      <img
                        src={portionReview.previewUrl}
                        alt={`Review-only 2.5D preview of ${dr.name || 'this dish'}`}
                      />
                    </div>
                    <span className={`s09-chip${portionReview.approved ? ' good' : ''}`}>
                      {portionReview.approved ? 'Approved for publication review' : 'Needs review'}
                    </span>
                    <p>
                      This generated image remains private until the menu is published with the
                      approved portion assets.
                    </p>
                    {!portionReview.approved && onApprovePortion && (
                      <Btn
                        kind="outlined"
                        size="md"
                        type="button"
                        onClick={onApprovePortion}
                        disabled={busy}
                      >
                        Approve 2.5D preview
                      </Btn>
                    )}
                  </>
                ) : (
                  <>
                    <span className="s09-chip">
                      {portionReview?.status === 'processing' ? 'Processing' : 'Not available'}
                    </span>
                    <p role="status">
                      {portionReview?.message ??
                        (portionReview?.status === 'processing'
                          ? 'Preparing the 2.5D preview from the dish photo.'
                          : 'The original dish photo remains the View Portion fallback until an approved 2.5D preview is published.')}
                    </p>
                  </>
                )}
              </section>
              {evidence}
            </>
          }
        >
          {sourceNote}
          {(error || suggestionError) && <p role="alert">{error || suggestionError}</p>}
          {showErrs && (
            <div id="errsum" role="alert" className="s09-errmsg">
              <Icon n="warn" s={24} />
              <b>Please correct the highlighted errors</b>
            </div>
          )}
          <TextField
            id="f-name"
            label="Dish name"
            required
            value={dr.name}
            {...errOf('f-name')}
            onChange={(e) => set({ name: e.target.value })}
          />
          <div className="s09-row3">
            <div>
              <CategoryField
                id="f-cat"
                value={dr.cat}
                categories={cats}
                error={err('f-cat')}
                onSelect={(cat) => set({ cat })}
                onAddCategory={(cat) => setCats((list) => [...list, cat])}
              />
              {fieldErr('f-cat')}
            </div>
            <TextField
              id="f-price"
              label={`Price (${currency})`}
              required
              inputMode="decimal"
              value={dr.price}
              {...errOf('f-price')}
              onChange={(e) => set({ price: priceInput(e.target.value) })}
            />
            <TextField
              id="f-size"
              label="Serving Size"
              required
              value={dr.size}
              {...errOf('f-size')}
              onChange={(e) => set({ size: e.target.value })}
            />
          </div>
          {servingCountControl}
          <div className="s09-desc">
            <div className="pp-field">
              <label className="pp-field__label" htmlFor="f-desc">
                Description
              </label>
              <textarea
                id="f-desc"
                rows={4}
                className="pp-input s09-textarea"
                placeholder="Add description if available..."
                value={dr.desc}
                onChange={(e) => set({ desc: e.target.value })}
              />
            </div>
            <div className="s09-airow">
              <Btn
                kind="primary"
                size="md"
                type="button"
                className={aiDraft ? 's09-on' : undefined}
                aria-pressed={!!aiDraft}
                disabled={busy || !draftDescription}
                onClick={() => {
                  setSuggestionError('');
                  void draftDescription?.(dr.name, dr.ing)
                    .then((text) => {
                      if (stillCurrent()) setAiDraft(text);
                    })
                    .catch(
                      () =>
                        stillCurrent() &&
                        setSuggestionError(
                          'AI suggestions are unavailable. Your dish has not changed.',
                        ),
                    );
                }}
              >
                {descriptionActionLabel}
              </Btn>
              <span className="s09-hint">
                {draftDescription
                  ? 'AI drafts need your approval'
                  : 'AI suggestions are not connected yet'}
              </span>
            </div>
            {aiDraft && (
              <div className="s09-aibox">
                <span className="s09-chip">AI draft</span>
                <p>{aiDraft}</p>
                <div className="s09-row">
                  <Btn
                    kind="primary"
                    size="md"
                    type="button"
                    onClick={() => {
                      setAi({ desc: aiDraft });
                      setAiDraft(null);
                    }}
                  >
                    Use this draft
                  </Btn>
                  <Btn kind="outlined" size="md" type="button" onClick={() => setAiDraft(null)}>
                    Discard
                  </Btn>
                </div>
              </div>
            )}
          </div>
          <div className="s09-list">
            <div className="s09-inrow">
              <TextField
                id="f-ing"
                label="Ingredients"
                required
                placeholder="Add an ingredient"
                hint="Ingredients are hidden from diners until you approve them"
                value={ingText}
                {...errOf('f-ing')}
                onChange={(e) => setIngText(e.target.value)}
                onKeyDown={onEnter(addIng)}
              />
              <Btn
                kind="outlined"
                size="md"
                type="button"
                disabled={!ingText.trim()}
                onClick={addIng}
                aria-label="Add ingredient"
              >
                Add
              </Btn>
              <Btn
                kind="primary"
                size="md"
                type="button"
                disabled={busy || !suggestIngredients}
                onClick={() => {
                  setSuggestionError('');
                  void suggestIngredients?.(dr.name)
                    .then((items) => {
                      if (!stillCurrent()) return;
                      const s = items.filter((x) => !dr.ing.includes(x));
                      if (!s.length) {
                        setSuggestionError(
                          'No additional ingredients were suggested. Your dish has not changed.',
                        );
                        return;
                      }
                      setAi({ ing: [...dr.ing, ...s], aiIng: [...dr.aiIng, ...s] });
                    })
                    .catch(
                      () =>
                        stillCurrent() &&
                        setSuggestionError(
                          'AI suggestions are unavailable. Your dish has not changed.',
                        ),
                    );
                }}
              >
                Suggest with AI
              </Btn>
            </div>
            {tags('Ingredients', dr.ing, dr.aiIng, (t) =>
              set({ ing: dr.ing.filter((x) => x !== t), aiIng: dr.aiIng.filter((x) => x !== t) }),
            )}
          </div>
          <div className="s09-list">
            <div className="s09-inrow">
              <TextField
                id="f-alg"
                label="Allergens"
                placeholder="Add an allergen"
                hint="Allergens are hidden from diners until you approve them"
                value={algText}
                onChange={(e) => setAlgText(e.target.value)}
                onKeyDown={onEnter(addAlg)}
              />
              <Btn
                kind="outlined"
                size="md"
                type="button"
                disabled={!algText.trim()}
                onClick={addAlg}
                aria-label="Add allergen"
              >
                Add
              </Btn>
              <Btn
                kind="primary"
                size="md"
                type="button"
                disabled={busy || !suggestAllergens}
                onClick={() => {
                  setSuggestionError('');
                  void suggestAllergens?.(dr.name, dr.ing)
                    .then((items) => {
                      if (!stillCurrent()) return;
                      const s = items.filter((x) => !dr.alg.includes(x));
                      setAi({ alg: [...dr.alg, ...s], aiAlg: [...dr.aiAlg, ...s] });
                    })
                    .catch(
                      () =>
                        stillCurrent() &&
                        setSuggestionError(
                          'AI suggestions are unavailable. Your dish has not changed.',
                        ),
                    );
                }}
              >
                Suggest with AI
              </Btn>
            </div>
            {tags('Allergens', dr.alg, dr.aiAlg, (t) =>
              set({ alg: dr.alg.filter((x) => x !== t), aiAlg: dr.aiAlg.filter((x) => x !== t) }),
            )}
          </div>
          <div className="pp-field">
            <label className="s09-check" htmlFor="f-ai">
              <input
                id="f-ai"
                type="checkbox"
                checked={dr.aiReviewed}
                aria-invalid={err('f-ai') ? true : undefined}
                aria-describedby={err('f-ai') ? 'f-ai-error' : undefined}
                onChange={(e) => set({ aiReviewed: e.target.checked })}
              />
              <span>I reviewed the AI-drafted text and ingredients. They are accurate.</span>
            </label>
            {fieldErr('f-ai')}
          </div>
          <div className="s09-btns">
            <Btn kind="outlined" size="lg" type="button" onClick={cancel}>
              Back
            </Btn>
            <Btn
              kind="primary"
              size="lg"
              type="submit"
              disabled={
                busy || (requireReviewBox && !dr.aiReviewed) || Boolean(dr.upload && !dr.rights)
              }
              aria-disabled={!ready}
              className={ready ? undefined : 's09-off'}
            >
              Continue to review
            </Btn>
          </div>
        </DishFormFrame>
      </fieldset>
    </form>
  );
}
