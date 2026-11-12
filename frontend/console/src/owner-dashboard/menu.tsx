// Menu management for the demo: list, edit/add form, review of what diners will see, saved.
// Changes live only in this page's memory.
import { useState } from 'react';
import { CATS, DISH, INSIGHTS, imgOf, type MenuItem, money, suggestIng } from './data';
import { allergenSummary, type DishFields, type FieldError } from './dish-fields';
import { DishForm } from './dish-form';
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

/** Demo dish -> the shared form's fields (dish-fields.ts). */
export function toFields(m: MenuItem): DishFields {
  return {
    name: m.name || null,
    category: m.cat || null,
    description: m.desc || null,
    priceAmount: m.price === '' ? null : String(m.price),
    priceCurrency: 'USD',
    ingredients: { status: m.ingStatus, items: m.ing },
    allergens: m.allergens,
    photoId: null,
  };
}

/** The shared form's fields -> demo dish, keeping the demo-only parts (photo, AI, 2.5D). */
export function fromFields(f: DishFields, m: MenuItem): MenuItem {
  return {
    ...m,
    name: f.name ?? '',
    cat: f.category ?? '',
    desc: f.description ?? '',
    price: f.priceAmount ?? '',
    ing: f.ingredients.items,
    aiIng: m.aiIng.filter((x) => f.ingredients.items.includes(x)),
    ingStatus: f.ingredients.status,
    allergens: f.allergens,
  };
}

/** The demo's Add/Edit Dish: the shared DishForm with sample data and the demo-only AI and 2.5D parts. */
export function MenuDishForm({
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
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const set = (p: Partial<MenuItem>) => setEd({ ...ed, draft: { ...dr, ...p } });
  const fromInsight = ed.from ? INSIGHTS.find((i) => i.id === ed.from) : undefined;
  return (
    <DishForm
      value={toFields(dr)}
      onChange={(f) => setEd({ ...ed, draft: fromFields(f, dr) })}
      onSave={toReview}
      onCancel={cancel}
      mode={orig ? 'edit' : 'add'}
      title={orig ? orig.name : 'New dish'}
      categories={CATS}
      photoUrl={imgOf(dr) || null}
      onPhotoSelect={(f) =>
        toDataUrl(f, (u) => {
          if (u) set({ upload: u, rights: false });
        })
      }
      validate={() => [
        ...(dr.upload && !dr.rights
          ? ([['f-rights', 'Confirm you have the right to use this photo.']] as FieldError[])
          : []),
        ...(dr.aiUsed && !dr.aiReviewed
          ? ([['f-ai', 'Confirm you reviewed the AI-drafted description.']] as FieldError[])
          : []),
      ]}
      slots={{
        notice: fromInsight && (
          <Note icon="info">
            Opened from a suggestion in your report: {fromInsight.action} Adding a 2.5D preview is
            not part of this form yet.
          </Note>
        ),
        descriptionTools: (
          <>
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
          </>
        ),
        ingredientTools: (
          <Btn
            kind="outlined"
            size="md"
            icon="spark"
            type="button"
            onClick={() => {
              const s = suggestIng(dr.name).filter((x) => !dr.ing.includes(x));
              // AI suggestions are only proposed: the owner must tick "I checked these ingredients".
              set({ ing: [...dr.ing, ...s], aiIng: [...dr.aiIng, ...s], ingStatus: 'proposed' });
            }}
          >
            Suggest with AI
          </Btn>
        ),
        ingredientBadge: (t) =>
          dr.aiIng.includes(t) && (
            <span className="lab rsn" style={{ padding: '1px 6px' }}>
              AI
            </span>
          ),
        afterFields: dr.aiUsed && (
          <label className="check" htmlFor="f-ai">
            <input
              id="f-ai"
              type="checkbox"
              checked={dr.aiReviewed}
              onChange={(e) => set({ aiReviewed: e.target.checked })}
            />
            <span>I reviewed the AI-drafted description. It is accurate.</span>
          </label>
        ),
        afterPhoto: dr.upload && (
          <label className="check" htmlFor="f-rights">
            <input
              id="f-rights"
              type="checkbox"
              checked={dr.rights}
              onChange={(e) => set({ rights: e.target.checked })}
            />
            <span>I have the right to use this photo.</span>
          </label>
        ),
        side: (
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
        ),
      }}
    />
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
      <p className="muted" style={{ fontSize: 13 }}>
        {allergenSummary(d.allergens)}
      </p>
    </div>
  );
}

export function Review({
  ed,
  orig,
  back,
  confirm,
  cancel,
}: {
  ed: Extract<EditState, { step: 'form' | 'review' }>;
  orig: MenuItem | null;
  back: () => void;
  confirm: (ingOk: boolean) => void;
  cancel: () => void;
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
        allergenSummary(orig.allergens) !== allergenSummary(dr.allergens) && 'Allergens',
      ].filter(Boolean)
    : ['New dish'];
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
      <div className="row">
        <Btn kind="primary" size="lg" type="button" onClick={() => confirm(ingOk)}>
          Approve and save
        </Btn>
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
  return (
    <div className="stack">
      <div className="pagehead">
        <span className="eyebrow">Step 3 of 3</span>
        <h1>{m.name} is saved</h1>
      </div>
      <Note kind="good" icon="check">
        Approved by you. Status:{' '}
        {m.status === 'live' ? 'Live on the diner menu.' : 'ready to publish.'} Human review before
        going live is a proposed step.
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
