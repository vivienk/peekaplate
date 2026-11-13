// Menu management for the demo: list, edit/add form, review of what diners will see, saved.
// Changes live only in this page's memory.
import { type FormEvent, useRef, useState } from 'react';
import { CATS, DISH, INSIGHTS, imgOf, type MenuItem, money, suggestIng } from './data';
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
  const [errs, setErrs] = useState<[string, string][]>([]);
  const [tag, setTag] = useState('');
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<MenuItem>) => setEd({ ...ed, draft: { ...dr, ...p } });
  const addTag = () => {
    const t = tag.trim();
    if (!t || dr.ing.includes(t)) return;
    set({ ing: [...dr.ing, t] });
    setTag('');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const er: [string, string][] = [];
    if (dr.name.trim().length < 2) er.push(['f-name', 'Enter a dish name.']);
    if (!(Number(dr.price) > 0)) er.push(['f-price', 'Enter a price greater than 0.']);
    if (dr.desc.trim().length < 20)
      er.push(['f-desc', 'Write a description of at least 20 characters.']);
    if (dr.ing.length < 1) er.push(['f-ing', 'Add at least one ingredient.']);
    if (!imgOf(dr)) er.push(['f-photo', 'Add a photo of the dish.']);
    if (dr.upload && !dr.rights)
      er.push(['f-rights', 'Confirm you have the right to use this photo.']);
    if (dr.aiUsed && !dr.aiReviewed)
      er.push(['f-ai', 'Confirm you reviewed the AI-drafted text and ingredients.']);
    setErrs(er);
    if (er.length) {
      setTimeout(() => document.getElementById('errsum')?.focus(), 0);
      return;
    }
    toReview();
  };
  const err = (id: string) => errs.find((x) => x[0] === id);
  const fromInsight = ed.from ? INSIGHTS.find((i) => i.id === ed.from) : undefined;
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div>
        <Btn kind="text" icon="back" type="button" onClick={cancel}>
          Back to Menu
        </Btn>
      </div>
      <div className="pagehead">
        <span className="eyebrow">{orig ? 'Edit dish' : 'Add dish'} · Step 1 of 3</span>
        <h1>{orig ? orig.name : 'New dish'}</h1>
        {fromInsight && (
          <Note icon="info">
            Opened from a suggestion in your report: {fromInsight.action} Adding a 2.5D preview is
            not part of this form yet.
          </Note>
        )}
      </div>
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
              value={dr.name}
              aria-invalid={!!err('f-name')}
              onChange={(e) => set({ name: e.target.value })}
            />
            {err('f-name') && <span className="err">{err('f-name')?.[1]}</span>}
          </div>
          <div className="grid g2">
            <div className="field">
              <label htmlFor="f-cat">Category</label>
              <select id="f-cat" value={dr.cat} onChange={(e) => set({ cat: e.target.value })}>
                {CATS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-price">Price (USD)</label>
              <input
                id="f-price"
                type="number"
                min="0"
                step="1"
                value={dr.price}
                aria-invalid={!!err('f-price')}
                onChange={(e) => set({ price: e.target.value })}
              />
              {err('f-price') && <span className="err">{err('f-price')?.[1]}</span>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="f-desc">Description</label>
            <textarea
              id="f-desc"
              rows={4}
              value={dr.desc}
              aria-invalid={!!err('f-desc')}
              onChange={(e) => set({ desc: e.target.value })}
            />
            {err('f-desc') && <span className="err">{err('f-desc')?.[1]}</span>}
            <div className="row">
              <Btn
                kind="outlined"
                size="md"
                icon="spark"
                type="button"
                onClick={() => {
                  const ing = dr.ing.length ? dr.ing : suggestIng(dr.name);
                  setAiDraft(
                    `${dr.name.trim() || 'This dish'}: ${ing.slice(0, 5).join(', ').toLowerCase()}, served fresh and made to order.`,
                  );
                }}
              >
                Draft with AI
              </Btn>
              <span className="hint">AI drafts need your approval.</span>
            </div>
          </div>
          {aiDraft && (
            <div className="aibox">
              <div className="row">
                <span className="lab rsn">AI draft</span>
              </div>
              <p>{aiDraft}</p>
              <div className="row">
                <Btn
                  kind="primary"
                  size="md"
                  type="button"
                  onClick={() => {
                    set({ desc: aiDraft, aiUsed: true, aiReviewed: false });
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
          <div className="field">
            <span className="fl" id="f-ing-l">
              Ingredients
            </span>
            <div className="tags" aria-labelledby="f-ing-l">
              {dr.ing.map((t) => (
                <span key={t} className={`tag${dr.aiIng.includes(t) ? ' ai' : ''}`}>
                  {t}
                  {dr.aiIng.includes(t) && (
                    <span className="lab rsn" style={{ padding: '1px 6px' }}>
                      AI
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${t}`}
                    onClick={() =>
                      set({
                        ing: dr.ing.filter((x) => x !== t),
                        aiIng: dr.aiIng.filter((x) => x !== t),
                      })
                    }
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
                style={{
                  flex: '1 1 160px',
                  border: '1.5px solid var(--line2)',
                  borderRadius: 12,
                  padding: '10px 12px',
                  minHeight: 44,
                  background: 'var(--surface)',
                }}
                aria-invalid={!!err('f-ing')}
              />
              <Btn kind="outlined" size="md" type="button" onClick={addTag}>
                Add
              </Btn>
              <Btn
                kind="outlined"
                size="md"
                icon="spark"
                type="button"
                onClick={() => {
                  const s = suggestIng(dr.name).filter((x) => !dr.ing.includes(x));
                  set({
                    ing: [...dr.ing, ...s],
                    aiIng: [...dr.aiIng, ...s],
                    aiUsed: true,
                    aiReviewed: false,
                  });
                }}
              >
                Suggest with AI
              </Btn>
            </div>
            {err('f-ing') && <span className="err">{err('f-ing')?.[1]}</span>}
            <span className="hint">Ingredients are hidden from diners until you approve them.</span>
          </div>
          {dr.aiUsed && (
            <label className="check" htmlFor="f-ai">
              <input
                id="f-ai"
                type="checkbox"
                checked={dr.aiReviewed}
                onChange={(e) => set({ aiReviewed: e.target.checked })}
              />
              <span>
                I reviewed the AI-drafted text and ingredients. They are accurate.
                {err('f-ai') && (
                  <span className="err" style={{ display: 'block' }}>
                    {err('f-ai')?.[1]}
                  </span>
                )}
              </span>
            </label>
          )}
        </section>
        <div className="stack">
          <section className="card stack">
            <h3>Photo</h3>
            <div className="dcard" style={{ background: 'var(--surface2)' }}>
              {imgOf(dr) ? (
                <img
                  src={imgOf(dr)}
                  alt={dr.name ? `${dr.name} photo` : 'Dish photo'}
                  style={{ width: 140, height: 140, objectFit: 'contain' }}
                />
              ) : (
                <span className="muted">No photo yet</span>
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
            <Btn kind="outlined" size="lg" type="button" onClick={() => fileRef.current?.click()}>
              {imgOf(dr) ? 'Replace photo' : 'Upload photo'}
            </Btn>
            {err('f-photo') && (
              <span className="err" id="f-photo-e">
                {err('f-photo')?.[1]}
              </span>
            )}
            {dr.upload && (
              <label className="check" htmlFor="f-rights">
                <input
                  id="f-rights"
                  type="checkbox"
                  checked={dr.rights}
                  onChange={(e) => set({ rights: e.target.checked })}
                />
                <span>
                  I have the right to use this photo.
                  {err('f-rights') && (
                    <span className="err" style={{ display: 'block' }}>
                      {err('f-rights')?.[1]}
                    </span>
                  )}
                </span>
              </label>
            )}
          </section>
          <section className="card stack">
            <h3>2.5D preview</h3>
            <div>
              <span className={`lab ${dr.has25 ? 'good' : 'st'}`}>
                {dr.has25 ? 'Available' : 'Not available'}
              </span>
            </div>
            <p className="muted" style={{ fontSize: 13.5 }}>
              {dr.has25
                ? 'Diners can tap “View in 2.5D” to see the ingredients floating apart.'
                : 'Until a preview exists, diners who tap “View in 2.5D” see the photo.'}
            </p>
          </section>
        </div>
      </div>
      <div className="row">
        <Btn kind="primary" size="lg" type="submit">
          Review changes
        </Btn>
        <Btn kind="outlined" size="lg" type="button" onClick={cancel}>
          Cancel
        </Btn>
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
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          Ingredients hidden until approved
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
            <span>Approve the ingredient list so diners can see it.</span>
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
