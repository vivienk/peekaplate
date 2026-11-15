import type { MenuApproval, PreparedMenu, PreparedMenuPreview } from '@peekaplate/contracts';
import { useEffect, useRef, useState } from 'react';
import {
  createOwnerMenuClient,
  newCommandId,
  OwnerMenuApiError,
  type OwnerMenuClient,
} from '../owner-menu/api';
import { Button } from '../ui';
import './owner-publish.css';

// Temporary S13 from Figma 3123:12796; replace presentation when the official screen lands.
// Snapshot preparation/admission remains operator-owned. Saved draft edits are not auto-published.
export function OwnerPublish({
  apiBase,
  actorId,
  venueId,
  getAccessToken,
  onAccessFailure,
  onBack,
}: {
  apiBase: string;
  actorId: string;
  venueId: string;
  getAccessToken: () => Promise<string | null>;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
  onBack: () => void;
}) {
  const active = useRef<{ client: OwnerMenuClient; controller: AbortController } | null>(null);
  const running = useRef(false);
  const attempt = useRef<{ approveId: string; publishId: string; approval?: MenuApproval } | null>(
    null,
  );
  const [menus, setMenus] = useState<PreparedMenu[]>([]);
  const [preview, setPreview] = useState<PreparedMenuPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [published, setPublished] = useState(false);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const publishButton = useRef<HTMLButtonElement>(null);

  const failure = (reason: unknown) => {
    if (reason instanceof OwnerMenuApiError && (reason.status === 401 || reason.status === 403)) {
      setMenus([]);
      setPreview(null);
      setLink('');
      onAccessFailure(reason.status === 401 ? 'signed_out' : 'denied');
    } else if (reason instanceof OwnerMenuApiError && reason.status === 409) {
      setPreview(null);
      attempt.current = null;
      setConfirm(false);
      setError('The menu changed. Reload prepared menus and review it again before publishing.');
    } else setError('We could not complete that request. Retry, or return to your saved dishes.');
  };

  useEffect(() => {
    void actorId;
    const controller = new AbortController();
    const current = {
      controller,
      client: createOwnerMenuClient({
        baseUrl: apiBase,
        getToken: getAccessToken,
        signal: controller.signal,
      }),
    };
    active.current = current;
    setBusy(true);
    setPreview(null);
    setLink('');
    setPublished(false);
    setError('');
    attempt.current = null;
    void current.client
      .listPreparedMenus(venueId)
      .then(setMenus)
      .catch((reason) => {
        if (!controller.signal.aborted) failure(reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      if (active.current === current) active.current = null;
    };
  }, [apiBase, actorId, venueId, getAccessToken]);

  useEffect(() => {
    if (confirm) dialog.current?.showModal();
    else if (dialog.current?.open) {
      dialog.current.close();
      publishButton.current?.focus();
    }
  }, [confirm]);

  async function run(action: (client: OwnerMenuClient, valid: () => boolean) => Promise<void>) {
    const current = active.current;
    if (!current || running.current) return;
    const valid = () => active.current === current && !current.controller.signal.aborted;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await action(current.client, valid);
    } catch (reason) {
      if (valid()) failure(reason);
    } finally {
      running.current = false;
      if (valid()) setBusy(false);
    }
  }

  const open = (menu: PreparedMenu) =>
    run(async (client, valid) => {
      setPreview(null);
      setLink('');
      setPublished(false);
      setConfirm(false);
      setCopied(false);
      setCategoryId('');
      attempt.current = null;
      const value = await client.previewPreparedMenu(venueId, menu.menuId, menu.menuRevisionId);
      if (!valid()) return;
      setPreview(value);
      const isPublished = value.menu.publishedRevisionId === value.menu.menuRevisionId;
      setPublished(isPublished);
      if (isPublished) {
        const url = await client.dinerLink(venueId, menu.menuId);
        if (valid()) setLink(url);
      }
    });
  const publish = () =>
    run(async (client, valid) => {
      if (!preview) return;
      const menu = preview.menu;
      attempt.current ??= { approveId: newCommandId(), publishId: newCommandId() };
      const request = attempt.current;
      request.approval ??= await client.approveMenu(venueId, menu.menuId, {
        commandId: request.approveId,
        expectedVersion: menu.reviewVersion,
        menuRevisionId: menu.menuRevisionId,
        contentApprovalId: menu.contentApprovalId,
        assetApprovalId: menu.assetApprovalId,
      });
      if (!valid()) return;
      await client.publishMenu(venueId, menu.menuId, {
        commandId: request.publishId,
        expectedVersion: menu.publicationVersion,
        approvalId: request.approval.approvalId,
      });
      if (!valid()) return;
      setPublished(true);
      setConfirm(false);
      const url = await client.dinerLink(venueId, menu.menuId);
      if (valid()) setLink(url);
    });
  const categories = preview?.content.categories ?? [];
  const dishes = categories.flatMap((category) => category.dishes);
  const complete = dishes.filter((dish) => dish.complete).length;

  return (
    <div className="owner-publish">
      <header>
        <h1>{published ? 'Your menu is published' : 'Preview your menu'}</h1>
        <small className="owner-workspace-design-note">
          (Temporary S13 — awaiting the official screen)
        </small>
        <p>
          {published
            ? 'Use your restaurant’s link to open and share the diner menu.'
            : 'Review this prepared menu before choosing to publish it.'}
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {!preview && (
        <section className="owner-publish__selection" aria-label="Prepared menus">
          {busy ? (
            <p role="status">Loading prepared menus…</p>
          ) : menus.length === 0 ? (
            <p>
              No prepared menu is ready yet. Your saved dishes stay private while the menu and
              photos are prepared for publication.
            </p>
          ) : (
            <>
              <p>
                Choose a prepared snapshot. Newer draft edits need preparation before they can
                appear here.
              </p>
              <ul>
                {menus.map((menu, index) => (
                  <li key={`${menu.menuId}:${menu.menuRevisionId}`}>
                    <Button variant="outline" disabled={busy} onClick={() => void open(menu)}>
                      Preview prepared menu {index + 1}
                      {menu.publishedRevisionId === menu.menuRevisionId ? ' — published' : ''}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Button
            variant="text"
            disabled={busy}
            onClick={() =>
              void run(async (client, valid) => {
                const next = await client.listPreparedMenus(venueId);
                if (valid()) setMenus(next);
              })
            }
          >
            Reload prepared menus
          </Button>
        </section>
      )}
      {preview && (
        <div className="owner-publish__grid">
          <section aria-label="Prepared menu preview" className="owner-publish__preview">
            <p className="owner-publish__badge">
              {published ? 'Published' : 'Preview — Not published'}
            </p>
            <div className="owner-publish__phone">
              <h2>{preview.content.restaurant.name}</h2>
              <nav aria-label="Preview categories">
                <Button
                  variant="outline"
                  aria-pressed={!categoryId}
                  onClick={() => setCategoryId('')}
                >
                  All
                </Button>
                {categories.map((category) => (
                  <Button
                    key={category.category_id}
                    variant="outline"
                    aria-pressed={categoryId === category.category_id}
                    onClick={() => setCategoryId(category.category_id)}
                  >
                    {category.name}
                  </Button>
                ))}
              </nav>
              {categories
                .filter((category) => !categoryId || category.category_id === categoryId)
                .map((category) => (
                  <section key={category.category_id}>
                    <h3>{category.name}</h3>
                    {category.dishes.map((dish) => (
                      <article key={dish.dish_id} className="owner-publish__dish">
                        {dish.complete ? (
                          <>
                            <img
                              src={dish.images.card.url}
                              alt={dish.images.card.alt}
                              referrerPolicy="no-referrer"
                            />
                            <h4>{dish.name}</h4>
                            <p className="owner-publish__price">
                              {new Intl.NumberFormat('en', {
                                style: 'currency',
                                currency: dish.price.currency,
                              }).format(Number(dish.price.amount))}{' '}
                              {dish.price.currency}
                            </p>
                            <p>{dish.description}</p>
                            <details>
                              <summary>Ingredients and allergens</summary>
                              <p>
                                {dish.ingredients.map((ingredient) => ingredient.name).join(', ') ||
                                  'No ingredients listed.'}
                              </p>
                              <p>
                                {dish.allergens === null
                                  ? 'Allergen information not provided.'
                                  : dish.allergens.length
                                    ? `Declared allergens: ${dish.allergens.join(', ')}.`
                                    : 'No allergens declared.'}
                              </p>
                            </details>
                          </>
                        ) : (
                          <p>This dish is not ready to display.</p>
                        )}
                      </article>
                    ))}
                  </section>
                ))}
            </div>
          </section>
          <aside className="owner-publish__link">
            <h2>Your menu link</h2>
            {link ? (
              <>
                <a href={link} target="_blank" rel="noreferrer">
                  {link}
                </a>
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(link)
                      .then(() => setCopied(true))
                      .catch(() =>
                        setError('Copy is unavailable. Select and copy the menu link above.'),
                      );
                  }}
                >
                  {copied ? 'Copied' : 'Copy URL'}
                </Button>
              </>
            ) : published ? (
              <>
                <p>Publication succeeded. Retrieve the link to share it.</p>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async (client, valid) => {
                      const url = await client.dinerLink(venueId, preview.menu.menuId);
                      if (valid()) setLink(url);
                    })
                  }
                >
                  Get diner link
                </Button>
              </>
            ) : (
              <p>
                Your unique diner URL appears after successful publication. This preview does not
                publish your menu.
              </p>
            )}
            <p>
              {complete} displayable dishes · {categories.length} categories
            </p>
            <p>
              Only this prepared snapshot will be published. Unsaved or newer draft edits are not
              included.
            </p>
          </aside>
        </div>
      )}
      <footer>
        <Button variant="outline" disabled={busy} onClick={onBack}>
          Back to Edit
        </Button>
        {preview && !published && (
          <button
            ref={publishButton}
            type="button"
            className="pp-button pp-button--action"
            disabled={busy || complete === 0}
            onClick={() => setConfirm(true)}
          >
            Publish Menu
          </button>
        )}
      </footer>
      <dialog
        ref={dialog}
        className="owner-dialog"
        aria-labelledby="owner-publish-confirm"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setConfirm(false);
        }}
      >
        <h2 id="owner-publish-confirm">Publish this menu?</h2>
        <p>
          This makes the prepared {preview?.content.restaurant.name} menu available to diners.
          Confirm that its dishes, prices, photos and food information are correct.
        </p>
        {confirm && error && <p role="alert">{error}</p>}
        <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>
          Keep reviewing
        </Button>
        <Button disabled={busy} onClick={() => void publish()}>
          {busy ? 'Publishing…' : 'Confirm and publish'}
        </Button>
      </dialog>
    </div>
  );
}
