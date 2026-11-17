import type { MenuApproval, PreparedMenu, PreparedMenuPreview } from '@peekaplate/contracts';
import { useEffect, useRef, useState } from 'react';
import { ActionButton, ErrorBanner } from '../auth/parts';
import {
  createOwnerMenuClient,
  newCommandId,
  OwnerMenuApiError,
  type OwnerMenuClient,
} from '../owner-menu/api';
import { DraftMenu } from '../publish/DraftMenu';
import { MenuPreview } from '../publish/MenuPreview';
import './owner-publish.css';

// S13 owner menu preview and publish (S6-FE-14; Figma 3123:12796 / 3123:12319, Publish
// Confirmation 3123:12795). Presentation is the official S13 (publish/MenuPreview.tsx); the data and
// publication logic are Sai's #197: prepared menus from the API, approval then publication with
// stable retry IDs, and the diner link read only after publication succeeds.
// Opening this screen (and "Prepare again") runs Part A preparation first: the owner's verified
// dishes become a prepared snapshot through the existing approval command and producer. It is safe
// to repeat after a failure. Preparing never publishes; publication stays this screen's explicit
// owner step, and saved draft edits are not auto-published.
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
  const [presentation, setPresentation] = useState<PreparedMenuPreview | null>(null);
  const previewPhotos = useRef<string[]>([]);
  const clearPreviewPhotos = () => {
    for (const url of previewPhotos.current) URL.revokeObjectURL(url);
    previewPhotos.current = [];
  };
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [published, setPublished] = useState(false);
  const [link, setLink] = useState('');
  const [prepareProblem, setPrepareProblem] = useState('');

  const failure = (reason: unknown) => {
    if (reason instanceof OwnerMenuApiError && (reason.status === 401 || reason.status === 403)) {
      setMenus([]);
      setPreview(null);
      setPresentation(null);
      clearPreviewPhotos();
      setLink('');
      onAccessFailure(reason.status === 401 ? 'signed_out' : 'denied');
    } else if (reason instanceof OwnerMenuApiError && reason.status === 409) {
      setPreview(null);
      setPresentation(null);
      clearPreviewPhotos();
      attempt.current = null;
      setError('The menu changed. Prepare again and review it again before publishing.');
    } else setError('We could not complete that request. Retry, or return to your saved dishes.');
  };

  // Open the exact snapshot returned by preparation, not an arbitrary historical menu.
  // A preparation failure keeps earlier snapshots available for explicit selection.
  async function prepareAndList(client: OwnerMenuClient, valid: () => boolean) {
    setPrepareProblem('');
    let prepared: Awaited<ReturnType<OwnerMenuClient['prepareMenu']>> | undefined;
    try {
      prepared = await client.prepareMenu(venueId);
    } catch (reason) {
      if (!valid()) return;
      if (reason instanceof OwnerMenuApiError && (reason.status === 401 || reason.status === 403))
        throw reason;
      // 404: preparation is not available here (production keeps operator preparation).
      if (!(reason instanceof OwnerMenuApiError && reason.status === 404))
        setPrepareProblem(
          reason instanceof OwnerMenuApiError && reason.code === 'menu_not_verified'
            ? 'Some dishes changed and need verifying again. Return to your dishes and complete verification, then prepare again.'
            : 'We couldn’t prepare your latest menu. Your verified dishes are saved; prepare again to retry.',
        );
    }
    if (!valid()) return;
    const next = await client.listPreparedMenus(venueId);
    if (!valid()) return;
    setMenus(next);
    const matches = next.filter(
      (menu) => menu.menuId === prepared?.menuId && menu.menuRevisionId === prepared.menuRevisionId,
    );
    if (matches.length === 1) await loadPreview(client, valid, matches[0]!);
  }

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
    void prepareAndList(
      current.client,
      () => active.current === current && !controller.signal.aborted,
    )
      .catch((reason) => {
        if (!controller.signal.aborted) failure(reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      clearPreviewPhotos();
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

  async function loadPreview(client: OwnerMenuClient, valid: () => boolean, menu: PreparedMenu) {
    setPreview(null);
    setPresentation(null);
    clearPreviewPhotos();
    setLink('');
    setPublished(false);
    attempt.current = null;
    const value = await client.previewPreparedMenu(venueId, menu.menuId, menu.menuRevisionId);
    if (!valid()) return;
    // The verified content/hash remains untouched. Only this presentation copy gets object URLs.
    const shown = structuredClone(value);
    try {
      for (const category of shown.content.categories)
        for (const dish of category.dishes) {
          if (!dish.complete || !dish.images) continue;
          const image = dish.images.card;
          if (!image.url.startsWith(`${apiBase}/public/prepared-assets/`)) continue;
          const blob = await client.readPreparedPreviewAsset(
            venueId,
            menu.menuId,
            menu.menuRevisionId,
            image.url,
          );
          if (!valid()) return;
          image.url = URL.createObjectURL(blob);
          previewPhotos.current.push(image.url);
        }
    } catch (error) {
      clearPreviewPhotos();
      throw error;
    }
    if (!valid()) return;
    setPresentation(shown);
    setPreview(value);
    const isPublished = value.menu.publishedRevisionId === value.menu.menuRevisionId;
    setPublished(isPublished);
    if (isPublished) {
      const url = await client.dinerLink(venueId, menu.menuId);
      if (valid()) setLink(url);
    }
  }
  const open = (menu: PreparedMenu) => run((client, valid) => loadPreview(client, valid, menu));
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
          {prepareProblem && (
            <ErrorBanner copy={{ title: 'Menu not prepared yet', body: prepareProblem }} />
          )}
          {busy ? (
            <p role="status" className="pp-menu-preview__helper">
              Preparing your menu…
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
              onClick={() => void run(prepareAndList)}
            >
              Prepare again
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
      phoneContent={presentation && <DraftMenu preview={presentation} />}
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
