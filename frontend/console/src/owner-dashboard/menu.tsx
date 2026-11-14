// Menu management for the demo: list, edit/add form, review of what diners will see, saved.
// Changes live only in this page's memory.
import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react';
import { TextField } from '../foundations/TextField';
import { CATS, DISH, INSIGHTS, imgOf, type MenuItem, money, suggestAlg, suggestIng } from './data';
import type { Acts } from './pages';
import { Btn, Icon, Note } from './ui';

export type EditState =
  | { step: 'list' }
  | { step: 'form' | 'review'; draft: MenuItem; origId: string | null; from?: string | null }
  | { step: 'saved'; saved: MenuItem };

export function MenuList({
  menu,
  startEdit,
  startAdd,
  publish,
  acts,
  openInsight,
}: {
  menu: MenuItem[];
  startEdit: (id: string) => void;
  startAdd: () => void;
  publish: (id: string) => void;
  acts: Acts;
  openInsight: (id: string) => void;
}) {
  const stLab = (m: MenuItem) =>
    m.status === 'live' ? (
      <span className="lab good">Live</span>
    ) : m.status === 'ready' ? (
      <span className="lab warn">Approved · ready to publish</span>
    ) : (
      <span className="lab st">Draft</span>
    );
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">Menu</span>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>Your dishes</h1>
          <Btn kind="primary" size="lg" icon="plus" type="button" onClick={startAdd}>
            Add dish
          </Btn>
        </div>
        <p className="lede">
          Edit a dish or add a new one. Changes are reviewed and approved by you before they can go
          live.
        </p>
      </div>
      <section className="card mtable">
        <div className="mrow mhead" aria-hidden="true">
          <span />
          <span>Dish</span>
          <span className="hidem">Category</span>
          <span className="hidem">Price</span>
          <span>Status</span>
          <span className="hidem">2.5D preview</span>
          <span />
        </div>
        {menu.map((m) => {
          const d = m.id ? DISH.find((x) => x.id === m.id) : undefined;
          return (
            <div key={m.id || m.name} className="mrow">
              <span className="thumb">
                <img src={imgOf(m)} alt="" />
              </span>
              <span className="dn">
                {m.name}
                <small>
                  {m.ing.length} ingredients{d && d.ord === null ? ' · no order record' : ''}
                </small>
                {INSIGHTS.filter(
                  (i) => i.dish === m.id && acts[i.id] && acts[i.id]?.status === 'planned',
                ).map((i) => (
                  <button
                    type="button"
                    key={i.id}
                    className="lab good linkchip"
                    onClick={() => openInsight(i.id)}
                  >
                    Planned from report: view insight
                  </button>
                ))}
              </span>
              <span className="hidem">{m.cat}</span>
              <span className="hidem num">{money(m.price)}</span>
              <span>{stLab(m)}</span>
              <span className="hidem">
                <span className={`lab ${m.has25 ? 'good' : 'st'}`}>
                  {m.has25 ? 'Available' : 'Not available'}
                </span>
              </span>
              <span className="row" style={{ flexWrap: 'nowrap' }}>
                {m.status === 'ready' && m.id && (
                  <Btn kind="primary" size="md" type="button" onClick={() => m.id && publish(m.id)}>
                    Publish
                  </Btn>
                )}
                <Btn
                  kind="outlined"
                  size="md"
                  type="button"
                  onClick={() => m.id && startEdit(m.id)}
                  aria-label={`Edit ${m.name}`}
                >
                  Edit
                </Btn>
              </span>
            </div>
          );
        })}
      </section>
      <Note icon="info">
        Publishing after approval is a proposed step. Ingredients stay hidden from diners until you
        approve them.
      </Note>
    </div>
  );
}

function toDataUrl(file: File, cb: (url: string | null) => void) {
  const r = new FileReader();
  r.onload = () => {
    const im = new Image();
    im.onload = () => {
      const s = Math.min(1, 320 / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width = Math.round(im.width * s);
      c.height = Math.round(im.height * s);
      c.getContext('2d')?.drawImage(im, 0, 0, c.width, c.height);
      cb(c.toDataURL('image/jpeg', 0.85));
    };
    im.onerror = () => cb(null);
    im.src = String(r.result);
  };
  r.onerror = () => cb(null);
  r.readAsDataURL(file);
}

// Screen 9, Add dish (Figma 1496:8021: Empty, Partially completed, Validation error, Draft with
// AI, Photo uploaded, Ready to review). Built only from the design system: TextField and the
// .pp-input box for fields, Btn (ui/Button) for buttons, and @peekaplate/tokens for every value.
// "Continue to review" looks disabled until the required fields are filled, but stays focusable
// and clickable so it can explain what is missing.
export function DishForm({
  ed,
  setEd,
  orig,
  cancel,
  toReview,
}: {
  ed: Extract<EditState, { step: 'form' | 'review' }>;
  setEd: (e: EditState) => void;
  orig: MenuItem | null;
  cancel: () => void;
  toReview: () => void;
}) {
  const dr = ed.draft;
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const [ingText, setIngText] = useState('');
  const [algText, setAlgText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<MenuItem>) => setEd({ ...ed, draft: { ...dr, ...p } });
  // Any AI suggestion needs a fresh review.
  const setAi = (p: Partial<MenuItem>) => set({ ...p, aiUsed: true, aiReviewed: false });
  const check = (d: MenuItem) => {
    const er: Record<string, string> = {};
    if (d.name.trim().length < 2) er['f-name'] = 'Enter a dish name';
    if (!d.cat) er['f-cat'] = 'Select a category';
    if (!/^\d+(\.\d{1,2})?$/.test(String(d.price).trim()) || !(Number(d.price) > 0))
      er['f-price'] = 'Enter a valid price';
    if (d.ing.length < 1) er['f-ing'] = 'Add at least one ingredient';
    if (d.upload && !d.rights) er['f-rights'] = 'Confirm you have the right to use this photo';
    if (d.aiUsed && !d.aiReviewed)
      er['f-ai'] = 'Confirm you reviewed the AI-drafted text and ingredients';
    return er;
  };
  const ready = Object.keys(check(dr)).length === 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
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
  const fromInsight = ed.from ? INSIGHTS.find((i) => i.id === ed.from) : undefined;
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
    <form className="s09" onSubmit={submit} noValidate>
      <div className="s09-grid">
        <section className="card s09-card" aria-labelledby="s09-title">
          <h1 id="s09-title">{orig ? 'Edit dish' : 'Add dish'}</h1>
          {fromInsight && (
            <Note icon="info">
              Opened from a suggestion in your report: {fromInsight.action} Adding a 2.5D preview is
              not part of this form yet.
            </Note>
          )}
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
          <div className="s09-two">
            <div className="pp-field">
              <label className="pp-field__label" htmlFor="f-cat">
                Category
              </label>
              <select
                id="f-cat"
                required
                className={`pp-input pp-field__control${dr.cat ? '' : ' s09-ph'}`}
                value={dr.cat}
                aria-invalid={err('f-cat') ? true : undefined}
                aria-describedby={err('f-cat') ? 'f-cat-error' : undefined}
                onChange={(e) => set({ cat: e.target.value })}
              >
                <option value="" disabled>
                  Select category
                </option>
                {CATS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              {fieldErr('f-cat')}
            </div>
            <TextField
              id="f-price"
              label="Price (USD)"
              required
              inputMode="decimal"
              value={dr.price}
              {...errOf('f-price')}
              onChange={(e) => set({ price: e.target.value })}
            />
          </div>
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
                onClick={() => {
                  const ing = dr.ing.length ? dr.ing : suggestIng(dr.name);
                  setAiDraft(
                    `${dr.name.trim() || 'This dish'}: ${ing.slice(0, 5).join(', ').toLowerCase()}, served fresh and made to order.`,
                  );
                }}
              >
                Draft with AI
              </Btn>
              <span className="s09-hint">AI drafts need your approval</span>
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
                onClick={addIng}
                aria-label="Add ingredient"
              >
                Add
              </Btn>
              <Btn
                kind="primary"
                size="md"
                type="button"
                onClick={() => {
                  const s = suggestIng(dr.name).filter((x) => !dr.ing.includes(x));
                  setAi({ ing: [...dr.ing, ...s], aiIng: [...dr.aiIng, ...s] });
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
                onClick={addAlg}
                aria-label="Add allergen"
              >
                Add
              </Btn>
              <Btn
                kind="primary"
                size="md"
                type="button"
                onClick={() => {
                  const s = suggestAlg(dr.name, dr.ing).filter((x) => !dr.alg.includes(x));
                  setAi({ alg: [...dr.alg, ...s], aiAlg: [...dr.aiAlg, ...s] });
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
              aria-disabled={!ready}
              className={ready ? undefined : 's09-off'}
            >
              Continue to review
            </Btn>
          </div>
        </section>
        <div className="s09-side">
          <section className="card s09-sidecard" aria-labelledby="s09-photo">
            <h2 id="s09-photo">Photo</h2>
            <div className={`s09-photo${imgOf(dr) ? ' has' : ''}`}>
              {imgOf(dr) ? (
                <img src={imgOf(dr)} alt={dr.name ? `${dr.name} photo` : 'Dish photo'} />
              ) : (
                <span>No photo yet</span>
              )}
            </div>
            <input
              ref={fileRef}
              id="f-photo"
              type="file"
              accept="image/*"
              className="sr"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  toDataUrl(f, (u) => {
                    if (u) set({ upload: u, rights: false });
                  });
              }}
            />
            <Btn kind="outlined" size="md" type="button" onClick={() => fileRef.current?.click()}>
              {imgOf(dr) ? 'Replace photo' : 'Upload photo'}
            </Btn>
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
            <span className={`s09-chip${dr.has25 ? ' good' : ''}`}>
              {dr.has25 ? 'Available' : 'Not available'}
            </span>
            <p>
              {dr.has25
                ? 'Diners can tap “View in 2.5D” to see the ingredients floating apart.'
                : 'Until a preview exists, diners who tap “View in 2.5D” see the photo.'}
            </p>
          </section>
        </div>
      </div>
    </form>
  );
}

function DinerCard({ d, showIng }: { d: MenuItem; showIng: boolean }) {
  return (
    <div className="dcard">
      <img src={imgOf(d)} alt="" />
      <h3>{d.name || 'Dish name'}</h3>
      <span className="muted">
        {d.cat} · {d.price ? money(d.price) : '—'}
      </span>
      <p style={{ fontSize: 13.5 }}>{d.desc || 'Description'}</p>
      {showIng ? (
        <p style={{ fontSize: 13 }}>
          <b>Ingredients:</b> {d.ing.join(', ')}
          {d.alg.length > 0 && (
            <>
              <br />
              <b>Allergens:</b> {d.alg.join(', ')}
            </>
          )}
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          Ingredients and allergens hidden until approved
        </p>
      )}
    </div>
  );
}

export function Review({
  ed,
  orig,
  back,
  confirm,
  cancel,
  onVerifyDish,
  onApprovePhoto,
}: {
  ed: Extract<EditState, { step: 'form' | 'review' }>;
  orig: MenuItem | null;
  back: () => void;
  confirm: (ingOk: boolean) => void;
  cancel: () => void;
  onVerifyDish?: () => void;
  onApprovePhoto?: () => void;
}) {
  const dr = ed.draft;
  const [ingOk, setIngOk] = useState(false);
  const ch = (k: keyof MenuItem) => orig && String(orig[k]) !== String(dr[k]);
  const changes = orig
    ? [
        ch('name') && 'Name',
        ch('cat') && 'Category',
        ch('price') && 'Price',
        ch('desc') && 'Description',
        orig.ing.join('|') !== dr.ing.join('|') && 'Ingredients',
        orig.alg.join('|') !== dr.alg.join('|') && 'Allergens',
        (orig.upload || '') !== (dr.upload || '') && 'Photo',
      ].filter(Boolean)
    : ['New dish'];

  const dishVerified = dr.dishVerificationStatus === 'verified';
  const photoVerified = dr.photoVerificationStatus === 'verified';

  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">{orig ? 'Edit dish' : 'Add dish'} · Step 2 of 3</span>
        <h1>Review what diners will see</h1>
        <p className="lede">
          Nothing changes on the diner menu until you approve.{' '}
          {changes.length ? `Changed: ${changes.join(', ')}.` : 'No fields changed.'}
        </p>
      </div>

      <div className="row" style={{ gap: 12, marginBottom: 8 }}>
        <span className={`lab ${dishVerified ? 'good' : 'warn'}`}>
          Dish Verification: {dishVerified ? 'Verified' : 'Not verified'}
        </span>
        <span className={`lab ${photoVerified ? 'good' : 'st'}`}>
          Photo Asset:{' '}
          {photoVerified
            ? 'Approved (menu-assets)'
            : dr.upload
              ? 'Staging (unverified)'
              : 'No photo'}
        </span>
      </div>

      <div className="diff">
        <div className="col">
          <h3>{orig ? 'Live now' : 'Not on the menu yet'}</h3>
          {orig ? <DinerCard d={orig} showIng /> : <div className="empty">This dish is new.</div>}
        </div>
        <div className="col">
          <h3>What diners will see</h3>
          <DinerCard d={dr} showIng={ingOk} />
          <label className="check" htmlFor="rv-ing">
            <input
              id="rv-ing"
              type="checkbox"
              checked={ingOk}
              onChange={(e) => setIngOk(e.target.checked)}
            />
            <span>Approve the ingredient and allergen lists so diners can see them.</span>
          </label>
        </div>
      </div>
      {dr.aiUsed && <Note icon="info">Includes AI-drafted content that you reviewed.</Note>}
      <Note icon="info">
        Verification must never block publishing: unverified dishes can be saved and published at
        any time.
      </Note>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <Btn kind="primary" size="lg" type="button" onClick={() => confirm(ingOk)}>
          Approve and save
        </Btn>
        {onVerifyDish && !dishVerified && (
          <Btn kind="outlined" size="lg" type="button" onClick={onVerifyDish}>
            Verify dish
          </Btn>
        )}
        {onApprovePhoto && dr.upload && !photoVerified && (
          <Btn kind="outlined" size="lg" type="button" onClick={onApprovePhoto}>
            Approve & promote photo
          </Btn>
        )}
        <Btn kind="outlined" size="lg" type="button" onClick={back}>
          Back to edit
        </Btn>
        <Btn kind="text" type="button" onClick={cancel}>
          Cancel, save nothing
        </Btn>
      </div>
    </div>
  );
}

export function Saved({
  m,
  publish,
  backToMenu,
}: {
  m: MenuItem;
  publish: (id: string) => void;
  backToMenu: () => void;
}) {
  const dishVerified = m.dishVerificationStatus === 'verified';
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">Step 3 of 3</span>
        <h1>{m.name} is saved</h1>
      </div>
      <div className="row" style={{ gap: 12, marginBottom: 8 }}>
        <span className={`lab ${dishVerified ? 'good' : 'warn'}`}>
          {dishVerified ? 'Dish verified' : 'Dish not verified'}
        </span>
        <span className={`lab ${m.photoVerificationStatus === 'verified' ? 'good' : 'st'}`}>
          {m.photoVerificationStatus === 'verified' ? 'Photo in menu-assets' : 'Photo in staging'}
        </span>
      </div>
      <Note kind="good" icon="check">
        Approved by you. Status:{' '}
        {m.status === 'live' ? 'Live on the diner menu.' : 'ready to publish.'} Unverified dishes
        can still be published without blocking.
      </Note>
      <div className="row">
        {m.status !== 'live' && (
          <Btn kind="primary" size="lg" type="button" onClick={() => m.id && publish(m.id)}>
            Publish to diner menu
          </Btn>
        )}
        <Btn kind="outlined" size="lg" type="button" onClick={backToMenu}>
          Back to Menu
        </Btn>
      </div>
    </div>
  );
}
