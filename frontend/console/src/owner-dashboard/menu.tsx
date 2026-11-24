// Menu management for the demo: list, edit/add form, review of what diners will see, saved.
// Changes live only in this page's memory.
import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react';
import { TextField } from '../foundations/TextField';
import { CategoryField } from './category-field';
import { DishFormView } from './DishFormView';
import { CATS, DISH, INSIGHTS, imgOf, type MenuItem, money, suggestAlg, suggestIng } from './data';
import { DishFormFrame, MenuTable } from './menu-presentation';
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
      <MenuTable>
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
      </MenuTable>
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

// Price (USD) keeps only digits and one decimal point with at most two decimals, so typing or
// pasting "$14.50" or "14,5" becomes "14.50" / "145" and letters never appear.
export { priceInput } from './DishFormView';

// Screen 9, Add dish (Figma 1496:8021: Empty, Partially completed, Validation error, Draft with
// AI, Photo uploaded, Ready to review). Built only from the design system: TextField and the
// .pp-input box for fields, Btn (ui/Button) for buttons, and @peekaplate/tokens for every value.
// "Continue to review" looks disabled until the required fields are filled, but stays focusable
// and clickable so it can explain what is missing.
export function DishForm(props: {
  ed: Extract<EditState, { step: 'form' | 'review' }>;
  setEd: (e: EditState) => void;
  orig: MenuItem | null;
  cancel: () => void;
  toReview: () => void;
  requireReviewBox?: boolean;
}) {
  const fromInsight = props.ed.from ? INSIGHTS.find((i) => i.id === props.ed.from) : undefined;
  return (
    <DishFormView
      {...props}
      categories={CATS}
      imageFor={imgOf}
      onSelectPhoto={(file) =>
        toDataUrl(file, (url) => {
          if (url)
            props.setEd({ ...props.ed, draft: { ...props.ed.draft, upload: url, rights: false } });
        })
      }
      suggestIngredients={async (name) => suggestIng(name)}
      suggestAllergens={async (name, ingredients) => suggestAlg(name, ingredients)}
      draftDescription={async (name, ingredients) => {
        const items = ingredients.length ? ingredients : suggestIng(name);
        return `${name.trim() || 'This dish'}: ${items.slice(0, 5).join(', ').toLowerCase()}, served fresh and made to order.`;
      }}
      sourceNote={
        fromInsight && (
          <Note icon="info">
            Opened from a suggestion in your report: {fromInsight.action} Adding a 2.5D preview is
            not part of this form yet.
          </Note>
        )
      }
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
        {d.size ? ` · ${d.size}` : ''}
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
          {d.diet.length > 0 && (
            <>
              <br />
              <b>Dietary:</b> {d.diet.join(', ')}
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
        ch('size') && 'Serving size',
        ch('desc') && 'Description',
        orig.ing.join('|') !== dr.ing.join('|') && 'Ingredients',
        orig.alg.join('|') !== dr.alg.join('|') && 'Allergens',
        orig.diet.join('|') !== dr.diet.join('|') && 'Dietary',
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
