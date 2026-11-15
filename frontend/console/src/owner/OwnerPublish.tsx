import type { MenuApproval, PreparedMenu, PreparedMenuPreview } from '@peekaplate/contracts';
import { useEffect, useRef, useState } from 'react';
import { ActionButton, ErrorBanner } from '../auth/parts';
import {
  createOwnerMenuClient,
  newCommandId,
  OwnerMenuApiError,
  type OwnerMenuClient,
} from '../owner-menu/api';
import { MenuPreview } from '../publish/MenuPreview';
import './owner-publish.css';

// S13 owner menu preview and publish (S6-FE-14; Figma 3123:12796 / 3123:12319, Publish
// Confirmation 3123:12795). Presentation is the official S13 (publish/MenuPreview.tsx); the data and
// publication logic are Sai's #197: prepared menus from the API, approval then publication with
// stable retry IDs, and the diner link read only after publication succeeds.
// Snapshot preparation/admission remains operator-owned. Saved draft edits are not auto-published.
export function OwnerPublish({
  apiBase,
  actorId,
  venueId,
  getAccessToken,
  onAccessFailure,
  onBack,
  onDone,
}: {
  apiBase: string;
  actorId: string;
  venueId: string;
  getAccessToken: () => Promise<string | null>;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
  onBack: () => void;
  /** "Go to dashboard" after publishing; defaults to onBack. */
  onDone?: () => void;
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
  const [published, setPublished] = useState(false);
  const [link, setLink] = useState('');

  const failure = (reason: unknown) => {
    if (reason instanceof OwnerMenuApiError && (reason.status === 401 || reason.status === 403)) {
      setMenus([]);
      setPreview(null);
      setLink('');
      onAccessFailure(reason.status === 401 ? 'signed_out' : 'denied');
    } else if (reason instanceof OwnerMenuApiError && reason.status === 409) {
      setPreview(null);
      attempt.current = null;
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
      const url = await client.dinerLink(venueId, menu.menuId);
      if (valid()) setLink(url);
    });
  const categories = preview?.content.categories ?? [];
  const dishes = categories.flatMap((category) => category.dishes);
  const complete = dishes.filter((dish) => dish.complete).length;

  if (!preview)
    return (
      <div className="pp-onboard pp-menu-preview-inline">
        <section
          className="pp-onboard__card owner-publish__choose"
          aria-labelledby="owner-publish-choose"
        >
          <h1 className="pp-onboard__title" id="owner-publish-choose">
            Preview your menu
          </h1>
          <p className="pp-menu-preview__lead">
            Choose the prepared menu to preview. Nothing is public until you publish.
          </p>
          {error && <ErrorBanner copy={{ title: 'Something went wrong', body: error }} />}
          {busy ? (
            <p role="status" className="pp-menu-preview__helper">
              Loading prepared menus…
            </p>
          ) : menus.length === 0 ? (
            <p className="pp-menu-preview__helper">
              No prepared menu is ready yet. Your saved dishes stay private while the menu and
              photos are prepared for publication.
            </p>
          ) : (
            <ul className="owner-publish__menus" aria-label="Prepared menus">
              {menus.map((menu, index) => (
                <li key={`${menu.menuId}:${menu.menuRevisionId}`}>
                  <ActionButton variant="outlined" onClick={() => void open(menu)}>
                    {`Preview prepared menu ${index + 1}${menu.publishedRevisionId === menu.menuRevisionId ? ' — published' : ''}`}
                  </ActionButton>
                </li>
              ))}
            </ul>
          )}
          <div className="pp-onboard__actions">
            <ActionButton variant="outlined" onClick={onBack}>
              Back to Edit
            </ActionButton>
            <ActionButton
              variant="outlined"
              busy={busy}
              busyLabel="Loading"
              onClick={() =>
                void run(async (client, valid) => {
                  const next = await client.listPreparedMenus(venueId);
                  if (valid()) setMenus(next);
                })
              }
            >
              Reload prepared menus
            </ActionButton>
          </div>
        </section>
      </div>
    );

  return (
    <MenuPreview
      layout="inline"
      restaurantName={preview.content.restaurant.name}
      dishCount={complete}
      categoryCount={categories.length}
      dinerUrl={link || null}
      phoneContent={<DraftMenu preview={preview} />}
      dishesMissingDetails={complete === 0 ? Math.max(1, dishes.length) : 0}
      notReadyBody="None of this menu’s dishes is ready to display yet. Return to your dishes, then prepare the menu again."
      publishing={busy}
      publishFailed={error || false}
      published={published}
      publishedUrl={link || null}
      onRetryLink={() =>
        void run(async (client, valid) => {
          const url = await client.dinerLink(venueId, preview.menu.menuId);
          if (valid()) setLink(url);
        })
      }
      panelNote="Only this prepared menu will be published. Newer draft edits are not included."
      onBackToEdit={onBack}
      onReviewDishes={onBack}
      onPublish={() => void publish()}
      onGoToDashboard={onDone ?? onBack}
    />
  );
}

// The prepared menu in the phone before publishing, in the diner's menu look: category tabs, then
// each dish with its photo, price and food information. Dishes not ready to display say so.
function DraftMenu({ preview }: { preview: PreparedMenuPreview }) {
  const [categoryId, setCategoryId] = useState('');
  const categories = preview.content.categories;
  return (
    <div aria-label="Draft diner menu" role="region">
      <h2>{preview.content.restaurant.name}</h2>
      <div className="pp-draft-menu__tabs" role="group" aria-label="Menu categories">
        <button
          type="button"
          className="pp-draft-menu__tab"
          aria-pressed={!categoryId}
          onClick={() => setCategoryId('')}
        >
          All
        </button>
        {categories.map((category) => (
          <button
            key={category.category_id}
            type="button"
            className="pp-draft-menu__tab"
            aria-pressed={categoryId === category.category_id}
            onClick={() => setCategoryId(category.category_id)}
          >
            {category.name}
          </button>
        ))}
      </div>
      {categories
        .filter((category) => !categoryId || category.category_id === categoryId)
        .map((category) => (
          <section key={category.category_id} className="pp-draft-menu__section">
            <h3>{category.name}</h3>
            {category.dishes.map((dish) => (
              <article key={dish.dish_id} className="pp-draft-menu__dish">
                {dish.complete ? (
                  <>
                    <img
                      src={dish.images.card.url}
                      alt={dish.images.card.alt}
                      referrerPolicy="no-referrer"
                    />
                    <div>
                      <h4>{dish.name}</h4>
                      <p className="pp-draft-menu__price">
                        {new Intl.NumberFormat('en', {
                          style: 'currency',
                          currency: dish.price.currency,
                        }).format(Number(dish.price.amount))}
                      </p>
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
                    </div>
                  </>
                ) : (
                  <p className="pp-draft-menu__missing">This dish is not ready to display.</p>
                )}
              </article>
            ))}
          </section>
        ))}
    </div>
  );
}
