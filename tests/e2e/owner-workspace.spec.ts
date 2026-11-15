import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { UNEEZA_REPORT } from '../../frontend/console/src/owner-dashboard/uneeza-report';
import type { DishDraft, MenuJob } from '../../frontend/console/src/owner-menu/api';
import { JOB, reviewSession } from '../../frontend/console/src/owner-menu/fixtures.test-helpers';

const origin = 'http://127.0.0.1:5174';
// Narrow main releases omit preview-only demo entries; runtime journeys still always run.
const authoredDemoAvailable = existsSync(
  new URL('../../frontend/console/owner-onboarding.html', import.meta.url),
);
test.afterEach(async ({ page }, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath('tested-state.png'), fullPage: true });
});
const api = 'https://peekaplate-api-staging.vxkong.workers.dev';
const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const venue = {
  venueId: '00000000-0000-4000-8000-000000000123',
  name: 'Synthetic Bridge Cafe',
  permission: 'owner',
};
const otherVenue = {
  venueId: '33333333-3333-4333-8333-333333333333',
  name: 'Other Synthetic Cafe',
  permission: 'owner',
};
const user = (id = ownerId) => ({
  id,
  aud: 'authenticated',
  role: 'authenticated',
  email: id === ownerId ? 'owner@example.test' : 'other@example.test',
  email_confirmed_at: '2026-11-11T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-11-11T00:00:00Z',
});
const token = (id: string, version = 0) =>
  `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600, version })).toString('base64url')}.c3ludGhldGlj`;
const session = (id: string, version = 0) => ({
  access_token: token(id, version),
  refresh_token: `synthetic-refresh-${id}`,
  token_type: 'bearer',
  expires_in: 3600,
  user: user(id),
});

function claims(authorization: string | undefined): { sub?: string; version?: number } {
  try {
    return JSON.parse(
      Buffer.from(
        authorization?.replace(/^Bearer /i, '').split('.')[1] ?? '',
        'base64url',
      ).toString(),
    );
  } catch {
    return {};
  }
}

async function fixture(context: BrowserContext) {
  const state = {
    venues: [venue],
    reportStatus: 200,
    denyIdentity: false,
    delayIdentity: false,
    releaseIdentity: () => {},
    identityRequests: 0,
    tokenVersion: 0,
    invalidActor: false,
    drafts: {} as Record<string, DishDraft[]>,
    jobs: {} as Record<string, MenuJob[]>,
    groups: new Map<string, { jobs: MenuJob[]; hashes: string[] }>(),
    photos: new Map<string, Buffer>(),
    receipts: new Map<string, unknown>(),
    conflictSave: false,
    menuStatus: 200,
    review: { ...reviewSession(), venueId: venue.venueId },
    correctionIds: [] as string[],
    delayUrl: false,
    urlStarted: false,
    releaseUrl: () => {},
    delayJobs: false,
    jobsReads: 0,
    releaseJobs: () => {},
    delayReview: false,
    reviewStarted: false,
    releaseReview: () => {},
    delayMembership: false,
    releaseMembership: () => {},
    delayReport: false,
    releaseReport: () => {},
    apiCalls: [] as Array<{ path: string; actor: string; version: number }>,
    analyses: [] as Array<{ venueId: string; actor: string; body: unknown }>,
    analysisStatus: 200,
    delayAnalysis: false,
    releaseAnalysis: () => {},
  };
  await context.route('https://auth-fixture.supabase.co/auth/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/').at(-1);
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*' },
      });
    let actor = claims(request.headers().authorization).sub || ownerId;
    if (path === 'token' && request.postDataJSON()?.email === 'other@example.test') actor = otherId;
    if (path === 'token' && typeof request.postDataJSON()?.refresh_token === 'string')
      actor = request.postDataJSON().refresh_token.replace('synthetic-refresh-', '');
    if (path === 'user') {
      state.identityRequests++;
      if (state.delayIdentity)
        await new Promise<void>((resolve) => {
          state.releaseIdentity = resolve;
        });
    }
    const status = path === 'user' && state.denyIdentity ? 401 : 200;
    await route.fulfill({
      status,
      json:
        status === 401
          ? { code: 'bad_jwt', message: 'Synthetic expired identity' }
          : path === 'token'
            ? session(actor, ++state.tokenVersion)
            : path === 'user'
              ? user(actor)
              : {},
      headers: { 'Access-Control-Allow-Origin': origin, 'X-Supabase-Api-Version': '2024-01-01' },
    });
  });
  await context.route(`${api}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*' },
      });
    const actor = claims(request.headers().authorization).sub ?? '';
    state.apiCalls.push({
      path: url.pathname,
      actor,
      version: claims(request.headers().authorization).version ?? 0,
    });
    const analysis = url.pathname.match(/^\/api\/v1\/venues\/([0-9a-f-]{36})\/ai\/analysis$/);
    if (analysis && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.analyses.push({ venueId: analysis[1] ?? '', actor, body });
      if (state.analysisStatus !== 200)
        return route.fulfill({
          status: state.analysisStatus,
          json: { error: 'denied' },
          headers: { 'Access-Control-Allow-Origin': origin },
        });
      if (state.delayAnalysis)
        await new Promise<void>((resolve) => {
          state.releaseAnalysis = resolve;
        });
      return route.fulfill({
        json: {
          schemaVersion: 'owner-analysis.v1',
          venueId: analysis[1],
          dishId: body.dishId,
          goal: body.goal,
          source: 'synthetic',
          reportSnapshot: 'a'.repeat(64),
          timeWindow: { start: '2026-11-11T12:00:00Z', end: '2026-11-12T12:00:00Z' },
          status: 'review',
          metric: 'open_rate',
          value: 0.5,
          reason: 'review_evidence',
          approvalRequired: true,
          allowedEffects: [],
        },
        headers: { 'Access-Control-Allow-Origin': origin },
      });
    }
    if (url.pathname === '/staff/venues') {
      const body = {
        actorId: state.invalidActor ? otherId : actor,
        venues: actor === otherId ? [otherVenue] : state.venues,
      };
      if (state.delayMembership)
        await new Promise<void>((resolve) => {
          state.releaseMembership = resolve;
        });
      await route
        .fulfill({ json: body, headers: { 'Access-Control-Allow-Origin': origin } })
        .catch(() => {});
    } else if (url.pathname.startsWith('/venues/')) {
      const id = url.pathname.split('/')[2]!;
      const path = url.pathname.split('/').slice(3).join('/');
      const headers = { 'Access-Control-Allow-Origin': origin };
      if (state.menuStatus !== 200)
        return route.fulfill({ status: state.menuStatus, json: { error: 'forbidden' }, headers });
      if (path === 'menus/jobs') {
        state.jobsReads++;
        if (state.delayJobs)
          await new Promise<void>((resolve) => {
            state.releaseJobs = resolve;
          });
        return route.fulfill({ json: { jobs: state.jobs[id] ?? [] }, headers });
      }
      if (path === 'menus/upload-groups') {
        const input = request.postDataJSON();
        const groupId = crypto.randomUUID();
        const jobs: MenuJob[] = input.files.map(
          (file: { sourceType: 'pdf' | 'photo' }, index: number) => ({
            id: crypto.randomUUID(),
            source_type: file.sourceType,
            upload_group_id: groupId,
            upload_index: index,
            source_uploaded: false,
            status: 'queued',
            attempt_count: 0,
            max_attempts: 3,
            error_code: null,
            draft_count: 0,
            created_at: '2026-11-15T00:00:00Z',
            started_at: null,
            finished_at: null,
          }),
        );
        state.groups.set(groupId, {
          jobs,
          hashes: input.files.map((file: { sourceHash: string }) => file.sourceHash),
        });
        state.jobs[id] = [...(state.jobs[id] ?? []), ...jobs];
        return route.fulfill({ status: 202, json: { group: { id: groupId, jobs } }, headers });
      }
      if (/^menus\/upload-groups\/[^/]+\/files\/\d$/.test(path)) {
        const groupId = path.split('/')[2]!;
        const index = Number(path.split('/')[4]);
        const group = state.groups.get(groupId)!;
        expect(createHash('sha256').update(request.postDataBuffer()!).digest('hex')).toBe(
          group.hashes[index],
        );
        group.jobs[index]!.source_uploaded = true;
        return route.fulfill({
          status: 202,
          json: {
            group: {
              id: groupId,
              jobs: group.jobs,
              ready: group.jobs.every((job) => job.source_uploaded),
            },
          },
          headers,
        });
      }
      if (/^menus\/upload-groups\/[^/]+\/cancel$/.test(path)) {
        const groupId = path.split('/')[2]!;
        const group = state.groups.get(groupId)!;
        for (const job of group.jobs) job.status = 'cancelled';
        return route.fulfill({ json: { group: { id: groupId, jobs: group.jobs } }, headers });
      }
      if (/^menus\/jobs\/[^/]+\/review-session$/.test(path)) {
        state.reviewStarted = true;
        if (state.delayReview)
          await new Promise<void>((resolve) => {
            state.releaseReview = resolve;
          });
        return route.fulfill({ json: state.review, headers });
      }
      if (/^extractions\/[^/]+\/candidates\/[^/]+\/review$/.test(path)) {
        const input = request.postDataJSON();
        const candidateId = decodeURIComponent(path.split('/')[3]!);
        const identity = `${path}:${JSON.stringify(input.corrected)}`;
        if (state.receipts.has(input.commandId) && state.receipts.get(input.commandId) !== identity)
          return route.fulfill({ status: 409, json: { error: 'command_conflict' }, headers });
        state.receipts.set(input.commandId, identity);
        state.correctionIds.push(input.commandId);
        const item = state.review.items.find(
          (value) => value.candidate.candidate_id === candidateId,
        )!;
        item.effective = { ...item.effective, ...input.corrected };
        item.review = {
          ...item.review,
          version: item.review.version + 1,
          corrected: input.corrected,
          editedFields: Object.keys(input.corrected) as typeof item.review.editedFields,
          reviewStatus: 'corrected',
        };
        return route.fulfill({ json: item, headers });
      }
      if (path === 'drafts')
        return route.fulfill({ json: { drafts: state.drafts[id] ?? [] }, headers });
      if (/^drafts\/[^/]+$/.test(path) && request.method() === 'PUT') {
        const draftId = path.split('/')[1]!;
        const input = request.postDataJSON();
        const rows = state.drafts[id] ?? [];
        const old = rows.find((draft) => draft.id === draftId);
        if (state.conflictSave || (old?.draft_version ?? 0) !== input.expectedVersion)
          return route.fulfill({ status: 409, json: { error: 'version_conflict' }, headers });
        const fields = input.fields;
        const draft: DishDraft = {
          id: draftId,
          draft_id: draftId,
          job_id: null,
          origin: 'manual',
          draft_version: input.expectedVersion + 1,
          name: fields.name,
          category: fields.category,
          description: fields.description,
          price_amount: fields.priceAmount,
          price_currency: fields.priceCurrency,
          source_text: null,
          ingredients: fields.ingredients.items,
          review_warnings: [],
          review_status: 'pending',
          manual_fields: fields,
        };
        state.drafts[id] = [...rows.filter((row) => row.id !== draftId), draft];
        return route.fulfill({ json: { draft }, headers });
      }
      if (/^drafts\/[^/]+\/photos$/.test(path)) {
        const bytes = request.postDataBuffer()!;
        const photoId = crypto.randomUUID();
        state.photos.set(photoId, bytes);
        return route.fulfill({
          status: 201,
          json: {
            photo: {
              id: photoId,
              draftId: path.split('/')[1],
              contentType: 'image/png',
              sizeBytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              verificationStatus: 'not_verified',
              storageKey: 'synthetic/private.png',
            },
          },
          headers,
        });
      }
      if (/^drafts\/[^/]+\/photos\/[^/]+$/.test(path))
        return route.fulfill({
          body: state.photos.get(path.split('/')[3]!)!,
          contentType: 'image/png',
          headers,
        });
      if (path === 'menus/url') {
        state.urlStarted = true;
        if (state.delayUrl)
          await new Promise<void>((resolve) => {
            state.releaseUrl = resolve;
          });
        const job: MenuJob = {
          id: crypto.randomUUID(),
          source_type: 'url',
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          error_code: null,
          draft_count: 0,
          source_uploaded: true,
          created_at: '2026-11-15T00:00:00Z',
          started_at: null,
          finished_at: null,
        };
        state.jobs[id] = [...(state.jobs[id] ?? []), job];
        return route.fulfill({
          status: 202,
          json: { group: { id: crypto.randomUUID(), jobs: [job] } },
          headers,
        });
      }
      return route.fulfill({ status: 404, json: { error: 'synthetic_not_found' }, headers });
    } else {
      if (state.delayReport)
        await new Promise<void>((resolve) => {
          state.releaseReport = resolve;
        });
      await route.fulfill({
        status: state.reportStatus,
        json:
          state.reportStatus === 200
            ? { ...UNEEZA_REPORT, venue_id: url.pathname.split('/')[4] }
            : { error: 'synthetic_denial' },
        headers: { 'Access-Control-Allow-Origin': origin },
      });
    }
  });
  return state;
}

async function signIn(page: Page, email = 'owner@example.test', openMenu = true) {
  await page.goto(`${origin}/owner-auth.html`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (openMenu) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  }
}

async function addCategory(page: Page, category: string) {
  await page.getByRole('combobox', { name: 'Category' }).click();
  const option = page.getByRole('option', { name: category, exact: true });
  if (await option.count()) await option.click();
  else {
    await page.getByRole('option', { name: 'Add category', exact: true }).click();
    await page.getByRole('textbox', { name: 'New category name', exact: true }).fill(category);
    await page.locator('.s09-cat__new').getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('option', { name: category, exact: true }).click();
  }
}

async function openAccount(page: Page) {
  const menu = page.locator('details.pp-onboard__account-menu');
  if ((await menu.count()) && (await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
}

async function preparedPublication(context: BrowserContext) {
  const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`;
  const menu = {
    venueId: venue.venueId,
    menuId: id(1),
    menuRevisionId: id(2),
    contentApprovalId: id(3),
    assetApprovalId: id(4),
    contentHash: 'a'.repeat(64),
    assetManifestHash: 'b'.repeat(64),
    bundleUrl: 'https://68d424e7.peekaplate-diner-staging.pages.dev/fixtures/synthetic.json',
    reviewVersion: 0,
    publicationVersion: 0,
    publishedRevisionId: null,
  };
  const photo = {
    url: 'https://68d424e7.peekaplate-diner-staging.pages.dev/fixtures/synthetic.webp',
    width: 480,
    height: 480,
    alt: 'Labelled synthetic test image',
  };
  const content = {
    schema_version: 1,
    venue_id: venue.venueId,
    menu_id: menu.menuId,
    menu_revision_id: menu.menuRevisionId,
    restaurant: { name: 'Synthetic Bridge Cafe', logo: null },
    categories: [
      {
        category_id: id(5),
        name: 'Lunch',
        dishes: [
          {
            dish_id: id(6),
            dish_revision_id: id(7),
            complete: true,
            name: 'Synthetic Garden Soup',
            description: 'Fictional soup used only for testing.',
            price: { amount: '8.50', currency: 'CAD' },
            ingredients: [],
            allergens: null,
            dietary: [],
            images: { card: photo, detail: photo },
          },
        ],
      },
    ],
  };
  const state = {
    approvals: [] as Record<string, unknown>[],
    publishes: [] as Record<string, unknown>[],
    publicationVersion: 0,
    approvalTimeout: false,
    conflict: false,
    denied: false,
    linkFailure: false,
  };
  const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*' };
  await context.route('**/venues/*/prepared-menus**', async (route) => {
    if (state.denied) return route.fulfill({ status: 403, json: { error: 'forbidden' }, headers });
    const liveMenu = {
      ...menu,
      publicationVersion: state.publicationVersion,
      publishedRevisionId: state.publicationVersion ? menu.menuRevisionId : null,
    };
    return route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('prepared-menus')
        ? { menus: [liveMenu] }
        : { menu: liveMenu, content },
      headers,
    });
  });
  await context.route(`**/menus/${menu.menuId}/*`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/diner-link'))
      return route.fulfill({
        status: state.linkFailure ? 503 : 200,
        json: state.linkFailure
          ? { error: 'service_unavailable' }
          : {
              path: '/diner/synthetic-bridge-cafe',
              url: 'https://routing-staging.peekaplate-diner-staging.pages.dev/diner/synthetic-bridge-cafe',
            },
        headers,
      });
    const input = route.request().postDataJSON();
    if (path.endsWith('/approvals')) {
      state.approvals.push(input);
      if (state.approvalTimeout) {
        state.approvalTimeout = false;
        return route.abort('failed');
      }
      return route.fulfill({
        json: {
          menuId: menu.menuId,
          approvalId: id(8),
          version: 1,
          menuRevisionId: menu.menuRevisionId,
          contentApprovalId: menu.contentApprovalId,
          assetApprovalId: menu.assetApprovalId,
          contentHash: menu.contentHash,
          assetManifestHash: menu.assetManifestHash,
          status: 'approved',
        },
        headers,
      });
    }
    state.publishes.push(input);
    if (state.conflict)
      return route.fulfill({ status: 409, json: { error: 'version_conflict' }, headers });
    state.publicationVersion = 1;
    return route.fulfill({
      json: {
        menuId: menu.menuId,
        approvalId: id(8),
        publicationId: id(9),
        version: 1,
        publicationHash: 'c'.repeat(64),
        availabilityVersion: 1,
        status: 'published',
      },
      headers,
    });
  });
  await context.route(photo.url, (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhNsAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  return state;
}

for (const width of [1440, 390]) {
  test(`prepared owner menu publishes only after confirmation and exposes the returned URL at ${width}px`, async ({
    context,
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1052 });
    await fixture(context);
    const state = await preparedPublication(context);
    await signIn(page);
    await page.getByRole('button', { name: 'Review and publish', exact: true }).click();
    await page.getByRole('button', { name: 'Preview prepared menu 1', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Synthetic Garden Soup' })).toBeVisible();
    await expect(page.getByText(/8.50 CAD/)).toBeVisible();
    await page.getByText('Ingredients and allergens', { exact: true }).click();
    await expect(page.getByText('Allergen information not provided.')).toBeVisible();
    expect(state.approvals).toHaveLength(0);
    expect(state.publishes).toHaveLength(0);
    await page.locator('.owner-publish__phone').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: testInfo.outputPath('s13-prepared-preview.png'),
      fullPage: true,
    });
    expect((await new AxeBuilder({ page }).include('.owner-publish').analyze()).violations).toEqual(
      [],
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Publish Menu', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('s13-publish-confirmation.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Confirm and publish', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your menu is published' })).toBeVisible();
    await expect(page.getByRole('link', { name: /routing-staging/ })).toHaveAttribute(
      'href',
      'https://routing-staging.peekaplate-diner-staging.pages.dev/diner/synthetic-bridge-cafe',
    );
    expect(state.approvals).toHaveLength(1);
    expect(state.publishes).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath('s13-published-link.png'), fullPage: true });
    await page.getByRole('button', { name: 'Back to Edit' }).click();
    await page.getByRole('button', { name: 'Review and publish' }).click();
    await page.getByRole('button', { name: /Preview prepared menu 1/ }).click();
    await expect(page.getByRole('heading', { name: 'Your menu is published' })).toBeVisible();
    expect(state.publishes).toHaveLength(1);
  });
}

test('prepared publication retries the same command and a failed link read never republishes', async ({
  context,
  page,
}) => {
  await fixture(context);
  const state = await preparedPublication(context);
  state.approvalTimeout = true;
  await signIn(page);
  await page.getByRole('button', { name: 'Review and publish' }).click();
  await page.getByRole('button', { name: 'Preview prepared menu 1', exact: true }).click();
  await page.getByRole('button', { name: 'Publish Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm and publish' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  state.linkFailure = true;
  await page.getByRole('button', { name: 'Confirm and publish' }).click();
  await expect(page.getByRole('button', { name: 'Get diner link' })).toBeVisible();
  expect(state.approvals[1]).toEqual(state.approvals[0]);
  state.linkFailure = false;
  await page.getByRole('button', { name: 'Get diner link' }).click();
  await expect(page.getByRole('link', { name: /routing-staging/ })).toBeVisible();
  expect(state.publishes).toHaveLength(1);
});

test('prepared publication conflict requires a fresh preview and denied access clears the screen', async ({
  context,
  page,
}) => {
  await fixture(context);
  const state = await preparedPublication(context);
  state.conflict = true;
  await signIn(page);
  await page.getByRole('button', { name: 'Review and publish' }).click();
  await page.getByRole('button', { name: 'Preview prepared menu 1', exact: true }).click();
  await page.getByRole('button', { name: 'Publish Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm and publish' }).click();
  await expect(
    page.getByText(
      'The menu changed. Reload prepared menus and review it again before publishing.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish Menu', exact: true })).toHaveCount(0);
  state.denied = true;
  await page.getByRole('button', { name: 'Reload prepared menus' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Garden Soup' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /routing-staging/ })).toHaveCount(0);
});

test('desktop panels stay in place while the middle scrolls, with account actions tucked away', async ({
  context,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 650 });
  await fixture(context);
  await signIn(page, undefined, false);
  await expect(page.locator('.owner-progress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh access', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeHidden();
  const left = await page.locator('.owner-sidebar').boundingBox();
  const right = await page.locator('.owner-ai').boundingBox();
  const heading = page.getByRole('heading', { name: 'Welcome to PeekaPlate' });
  const before = await heading.boundingBox();
  await page.locator('.owner-main').evaluate((element) => element.scrollTo(0, 500));
  await expect.poll(async () => (await heading.boundingBox())!.y).toBeLessThan(before!.y);
  expect(await page.locator('.owner-sidebar').boundingBox()).toEqual(left);
  expect(await page.locator('.owner-ai').boundingBox()).toEqual(right);
  await page.screenshot({
    path: testInfo.outputPath('desktop-middle-scrolled.png'),
    fullPage: true,
  });
  await page.locator('.owner-main').evaluate((element) => element.scrollTo(0, 0));
  await openAccount(page);
  await expect(page.getByRole('button', { name: 'Refresh access', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-account-menu.png'), fullPage: true });
});

test('long restaurant names fit the dashboard and onboarding account menu', async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(context);
  state.venues = [
    { ...venue, name: 'RES-02 SYNTHETIC VERIFICATION 2026-11-01 A - not a restaurant' },
  ];
  await signIn(page, undefined, false);
  await expect(page.locator('.owner-progress')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  await page.locator('summary[aria-label="Owner account"]').click();
  await expect(page.getByLabel('Restaurant', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('menu typography and locked-page copy keep the authored live boundary', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your dishes', exact: true })).toHaveCSS(
    'font-size',
    '28px',
  );
  await expect(page.locator('.owner-nav-hint')).toHaveText(
    'Some screens are not connected in this workspace yet.',
  );
  state.venues = [{ ...venue, permission: 'editor' }];
  await openAccount(page);
  await page.getByRole('button', { name: 'Refresh access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dish performance', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.locator('.owner-nav-hint')).not.toContainText('after you publish');
});

test('a browser file with no MIME keeps original bytes and a declared PDF upload', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
  await page.getByText('Upload photos/PDF', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const original = Buffer.from('%PDF-1.7 synthetic empty MIME fixture');
  const sent: Array<{ type: string | undefined; body: Buffer | null }> = [];
  page.on('request', (request) => {
    if (/\/upload-groups\/[^/]+\/files\/0$/.test(new URL(request.url()).pathname))
      sent.push({ type: request.headers()['content-type'], body: request.postDataBuffer() });
  });
  // Playwright infers a MIME for file payloads; emulate the browser's actual empty-type File.
  await page
    .locator('input[type=file]')
    .first()
    .evaluate((input) => {
      const files = new DataTransfer();
      files.items.add(
        new File(['%PDF-1.7 synthetic empty MIME fixture'], 'synthetic.pdf', { type: '' }),
      );
      (input as HTMLInputElement).files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  await expect.poll(() => state.jobs[venue.venueId]?.[0]?.source_uploaded).toBe(true);
  expect(sent).toEqual([{ type: 'application/pdf', body: original }]);
});

test('the live dish approval describes the category validation error', async ({ page }) => {
  test.skip(!authoredDemoAvailable, 'Preview-only fixture entry is absent from this release.');
  await page.route('**/src/onboarding/demo.tsx*', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const react = source.match(/from ["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    const dom = source.match(/from ["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
    expect(react).toBeDefined();
    expect(dom).toBeDefined();
    await route.fulfill({
      response,
      body: `import React from ${JSON.stringify(react)};
      import ReactDOM from ${JSON.stringify(dom)};
      import {DishEditor} from '/src/owner-menu/DishEditor.tsx';
      import {emptyManualDish} from '/src/owner-menu/dishForm.ts';
      import {OnboardingLayout} from '/src/onboarding/OnboardingLayout.tsx';
      function Case(){const [value,set]=React.useState(emptyManualDish());return React.createElement(OnboardingLayout,{bare:true},React.createElement(DishEditor,{value,onChange:set,onSave(){},onVerify(){},onCancel(){}}));}
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Case));`,
    });
  });
  await page.goto(`${origin}/owner-onboarding.html`);
  await page.getByRole('button', { name: 'Approve dish', exact: true }).click();
  const category = page.getByRole('combobox', { name: /Category/ });
  await expect(category).toHaveAttribute('aria-describedby', 'dish-category-error');
  await expect(page.locator('#dish-category-error')).toHaveText('Enter a category.');
});

for (const width of [1440, 390]) {
  test(`records original regression demo pages at ${width}px`, async ({ page }, testInfo) => {
    test.skip(!authoredDemoAvailable, 'Preview-only demo entries are absent from this release.');
    await page.setViewportSize({ width, height: 1052 });
    await page.goto(`${origin}/owner-onboarding.html`);
    await expect(page.getByLabel('Restaurant name')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('demo-only-restaurant-details.png'),
      fullPage: true,
    });
    await page.goto(`${origin}/first-dashboard.html`);
    await page.getByLabel('Setup state').selectOption('details');
    await page.screenshot({
      path: testInfo.outputPath('demo-only-first-dashboard.png'),
      fullPage: true,
    });
    await page.goto(`${origin}/owner-dashboard.html`);
    await page.getByRole('button', { name: 'Menu', exact: true }).first().click();
    await page.screenshot({ path: testInfo.outputPath('demo-only-menu-list.png'), fullPage: true });
    await page
      .getByRole('button', { name: /Add dish/ })
      .first()
      .click();
    await page.screenshot({ path: testInfo.outputPath('demo-only-dish-form.png'), fullPage: true });
  });
}

for (const width of [1440, 390]) {
  test(`records every connected owner page at ${width}px`, async ({ context, page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: width === 1440 ? 1052 : 844 });
    const state = await fixture(context);
    let shot = 0;
    const capture = async (name: string) => {
      await page.screenshot({
        path: testInfo.outputPath(`${String(++shot).padStart(2, '0')}-${name}.png`),
        fullPage: true,
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    };
    await page.goto(`${origin}/owner-auth.html`);
    await capture('email-entry');
    await page.getByLabel('Email address').fill('owner@example.test');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await capture('sign-in');
    await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('.owner-progress')).toBeVisible();
    await capture('first-dashboard');
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your dishes', exact: true })).toBeVisible();
    await capture('menu-empty');
    await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
    await capture('source-choice');
    await page.getByText('Paste URL', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await capture('menu-link');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByText('Upload photos/PDF', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await capture('menu-upload');
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: 'synthetic.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
    await expect.poll(() => state.jobs[venue.venueId]?.[0]?.source_uploaded).toBe(true);
    await capture('upload-preview');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Queued for processing', { exact: true })).toBeVisible();
    await capture('menu-processing');
    await page.getByRole('button', { name: 'View saved dishes', exact: true }).click();
    await page.getByRole('button', { name: 'Add dish', exact: true }).click();
    await capture('dish-empty');
    await page.getByLabel('Dish name', { exact: true }).fill('Fictional soup');
    await addCategory(page, 'Soup');
    await page.getByLabel('Price', { exact: true }).fill('9.50');
    await page.getByLabel('Currency', { exact: true }).fill('USD');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(
      page.getByText('Draft saved. This has not approved or published your menu.'),
    ).toBeVisible();
    await capture('dish-saved');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await capture('menu-saved');
    await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
    await expect(page.getByRole('table')).toBeVisible();
    await capture('owner-report');
    if (process.env.PEEKAPLATE_TEST_OWNER_AI !== 'false') {
      const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
      await panel.getByRole('button', { name: 'Review report' }).click();
      await expect(panel.getByRole('heading', { name: 'Suggested review' })).toBeVisible();
      await capture('ai-report-synthetic-http');
    }
    state.reportStatus = 403;
    state.venues = [];
    await page.getByRole('button', { name: 'Restaurant Setup', exact: true }).click();
    await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No restaurant access yet' })).toBeVisible();
    await capture('access-denied');
  });
}

test('restores the authored first dashboard instead of the wiring list', async ({
  context,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1052 });
  await fixture(context);
  await signIn(page, 'owner@example.test', false);
  await expect(
    page.getByRole('heading', { name: 'Welcome to PeekaPlate', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.owner-progress')).toBeVisible();
  await expect(page.locator('.owner-step')).toHaveCount(3);
  await expect(page.locator('.owner-verify')).toBeVisible();
  await expect(page.getByText('Status unavailable', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('0 of 3 steps complete', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('main')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('authored-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
  await page.screenshot({ path: testInfo.outputPath('authored-mobile.png'), fullPage: true });
});

test('keeps the authored onboarding frame and Screen 9 cards when connected', async ({
  context,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1358 });
  await fixture(context);
  await signIn(page, 'owner@example.test', false);
  await page.getByRole('button', { name: 'Add your menu', exact: true }).click();
  await expect(page.locator('.pp-onboard')).toBeVisible();
  await expect(page.locator('.pp-onboard__nav')).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
  await expect(page.locator('.pp-onboard-option')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('source-choice-desktop.png'), fullPage: true });
  await page.getByText('Upload photos/PDF', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('upload-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByText('Add manually', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.s09-grid')).toBeVisible();
  await expect(page.locator('.s09-card')).toBeVisible();
  await expect(page.locator('.s09-sidecard').first()).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('authored-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
  await page.screenshot({ path: testInfo.outputPath('authored-mobile.png'), fullPage: true });
});

test('manual dish and original private photo survive save and reload', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  await page.getByLabel('Dish name', { exact: true }).fill('Fictional Lentil Soup');
  await addCategory(page, 'Soup');
  await page.getByLabel('Price', { exact: true }).fill('9.50');
  await page.getByLabel('Currency', { exact: true }).fill('USD');
  const original = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page
    .getByLabel('Dish photo', { exact: true })
    .setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: original });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(
    page.getByText('Draft saved. This has not approved or published your menu.'),
  ).toBeVisible();
  expect([...state.photos.values()][0]).toEqual(original);
  expect(state.drafts[venue.venueId]?.[0]?.manual_fields).toMatchObject({
    allergens: { status: 'unknown', items: [] },
  });
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Fictional Lentil Soup', exact: true }).click();
  await expect(page.getByLabel('Price', { exact: true })).toHaveValue('9.50');
  await expect(page.getByRole('img', { name: 'Private draft dish' })).toBeVisible();
  expect(state.apiCalls.some((call) => /approve|publications/.test(call.path))).toBe(false);
});

test('URL and manual sources share saved work and queued status is not a fake success', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
  await page.getByText('Paste URL', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Paste URL' })).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Menu URL').fill('https://restaurant.example/menu.pdf');
  await page.getByRole('button', { name: 'Import menu', exact: true }).click();
  await expect(page.getByText('Queued for processing', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View saved dishes', exact: true }).click();
  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add dish', exact: true })).toBeVisible();
  await page.getByLabel('Dish name', { exact: true }).fill('Fictional side salad');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(
    page.getByText('Draft saved. This has not approved or published your menu.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByText('Saved sources (1)', { exact: true }).click();
  await expect(page.getByText('URL source — queued; 0 dishes.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Edit Fictional side salad', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit Fictional side salad', exact: true }),
  ).toBeVisible();
  expect(state.jobs[venue.venueId]).toHaveLength(1);
});

test('a stale draft save leaves the current edit visible instead of reporting success', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  await page.getByLabel('Dish name', { exact: true }).fill('Unsaved fictional soup');
  state.conflictSave = true;
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Saved data changed');
  await expect(page.getByLabel('Dish name', { exact: true })).toHaveValue('Unsaved fictional soup');
  expect(state.drafts[venue.venueId]).toBeUndefined();
});

test('photo replacement cancels its immutable group and PDF stays a separate source in the same workspace', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
  await page.getByText('Upload photos/PDF', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: image });
  await expect.poll(() => state.jobs[venue.venueId]?.[0]?.source_uploaded).toBe(true);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace first.png', exact: true }).click();
  await (await chooser).setFiles({
    name: 'replacement.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([image, Buffer.from([0])]),
  });
  await expect.poll(() => state.jobs[venue.venueId]?.length).toBe(2);
  expect(state.jobs[venue.venueId]?.[0]?.status).toBe('cancelled');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'View saved dishes', exact: true }).click();
  await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
  await page.getByText('Upload photos/PDF', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'synthetic.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7 synthetic HTTP fixture only'),
    });
  await expect.poll(() => state.jobs[venue.venueId]?.length).toBe(3);
  await expect.poll(() => state.jobs[venue.venueId]?.[2]?.source_uploaded).toBe(true);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Queued for processing', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View saved dishes', exact: true }).click();
  await page.getByText('Saved sources (3)', { exact: true }).click();
  await expect(page.getByText('PHOTO source — queued; 0 dishes.')).toBeVisible();
  await expect(page.getByText('PDF source — queued; 0 dishes.')).toBeVisible();
});

test('revoked menu access removes saved private state and reloads memberships', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Reload saved work', exact: true })).toBeVisible();
  state.menuStatus = 403;
  state.venues = [];
  await page.getByRole('button', { name: 'Reload saved work', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No restaurant access yet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: venue.name })).toHaveCount(0);
});

test('a delayed URL import cannot reopen a screen the owner left', async ({ context, page }) => {
  const state = await fixture(context);
  state.delayUrl = true;
  await signIn(page);
  await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
  await page.getByText('Paste URL', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Menu URL').fill('https://restaurant.example/menu.pdf');
  await page.getByRole('button', { name: 'Import menu', exact: true }).click();
  await expect.poll(() => state.urlStarted).toBe(true);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  state.releaseUrl();
  await expect.poll(() => state.jobs[venue.venueId]?.length).toBe(1);
  await expect(page.getByRole('heading', { name: 'Choose how to add your menu' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Add dish', exact: true })).toHaveCount(0);
});

test('processing waits for a slow status read instead of invalidating it with another poll', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.jobs[venue.venueId] = [
    {
      id: JOB,
      source_type: 'pdf',
      status: 'queued',
      attempt_count: 0,
      max_attempts: 3,
      error_code: null,
      draft_count: 0,
      source_uploaded: true,
      created_at: '2026-11-15T00:00:00Z',
      started_at: null,
      finished_at: null,
    },
  ];
  await page.clock.install();
  await signIn(page);
  await page.getByText('Saved sources (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'View processing', exact: true }).click();
  state.delayJobs = true;
  state.jobsReads = 0;
  await page.clock.runFor(5000);
  await expect.poll(() => state.jobsReads).toBe(1);
  await page.clock.runFor(5000);
  expect(state.jobsReads).toBe(1);
  state.jobs[venue.venueId]![0]!.status = 'complete';
  state.releaseJobs();
  await expect(
    page.getByText(
      'Processing status updated. Review the saved dishes and any failed sources below.',
    ),
  ).toBeVisible();
  await page.getByText('Saved sources (1)', { exact: true }).click();
  await expect(page.getByText('PDF source — complete; 0 dishes.')).toBeVisible();
});

test('identical corrections on separate extracted candidates get separate command identities', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const candidates = state.review.items.slice(0, 2);
  state.drafts[venue.venueId] = candidates.map((item) => ({
    id: crypto.randomUUID(),
    draft_id: crypto.randomUUID(),
    job_id: JOB,
    candidate_id: item.candidate.candidate_id,
    origin: 'extracted',
    draft_version: 1,
    name: item.effective.name,
    category: item.effective.category ?? null,
    description: item.effective.description ?? null,
    price_amount: item.effective.price_amount ?? null,
    price_currency: item.effective.price_currency ?? null,
    ingredients: item.effective.ingredients ?? null,
    source_text: 'Synthetic source',
    review_warnings: [],
    review_status: 'pending',
  }));
  await signIn(page);
  for (const item of candidates) {
    await page.getByRole('button', { name: `Edit ${item.effective.name}`, exact: true }).click();
    await addCategory(page, 'Sides');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(
      page.getByText('Draft saved. This has not approved or published your menu.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  expect(state.correctionIds).toHaveLength(2);
  expect(new Set(state.correctionIds).size).toBe(2);
});

test('a delayed review session cannot reopen an editor after shell navigation', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const item = state.review.items[0]!;
  state.drafts[venue.venueId] = [
    {
      id: crypto.randomUUID(),
      draft_id: crypto.randomUUID(),
      job_id: JOB,
      candidate_id: item.candidate.candidate_id,
      origin: 'extracted',
      draft_version: 1,
      name: item.effective.name,
      category: item.effective.category ?? null,
      description: item.effective.description ?? null,
      price_amount: item.effective.price_amount ?? null,
      price_currency: item.effective.price_currency ?? null,
      ingredients: item.effective.ingredients ?? null,
      source_text: 'Synthetic source',
      review_warnings: [],
      review_status: 'pending',
    },
  ];
  state.delayReview = true;
  await signIn(page);
  await page.getByRole('button', { name: `Edit ${item.effective.name}`, exact: true }).click();
  await expect.poll(() => state.reviewStarted).toBe(true);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  state.releaseReview();
  await expect(page.locator('.owner-menu-workspace')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Your dishes', exact: true })).toBeVisible();
  await expect(page.getByLabel('Category', { exact: true })).toHaveCount(0);
});

test('real SDK sign-in opens the server restaurant shell and authenticated report', async ({
  context,
  page,
}, testInfo) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-identity__name')).toHaveText(venue.name);
  await expect(page.getByRole('heading', { name: 'Your dishes' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('owner-workspace-desktop.png'),
    fullPage: true,
  });
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'AI Insight Report', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(
    page.getByText('Synthetic test data from the report API. Not real diners.'),
  ).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'PeekaPlate AI' })).toHaveCount(
    process.env.PEEKAPLATE_TEST_OWNER_AI === 'false' ? 0 : 1,
  );
  expect(state.apiCalls.every((call) => call.actor === ownerId)).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.locator('.owner-identity__name')).toHaveText(venue.name);
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
});

test('new accounts without restaurant membership see an honest empty state', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.venues = [];
  await signIn(page, undefined, false);
  await expect(page.getByRole('heading', { name: 'No restaurant access yet' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
  expect(state.apiCalls.map((call) => call.path)).toEqual(['/staff/venues']);
});

test('multiple restaurants require selection and a switch removes the old report', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.venues = [venue, otherVenue];
  await signIn(page, undefined, false);
  await expect(page.getByRole('heading', { name: 'Choose a restaurant' })).toBeVisible();
  await openAccount(page);
  await page.getByLabel('Restaurant', { exact: true }).selectOption(venue.venueId);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await openAccount(page);
  await page.getByLabel('Restaurant', { exact: true }).selectOption(otherVenue.venueId);
  await expect(page.locator('.owner-identity__name')).toHaveText(otherVenue.name);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('editor access does not enable owner-only reports or publication', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.venues = [{ ...venue, permission: 'editor' }];
  await signIn(page, undefined, false);
  await expect(page.locator('.owner-identity__name')).toHaveText(venue.name);
  await expect(page.getByRole('button', { name: 'Dish performance', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your dishes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review and publish' })).toHaveCount(0);
  expect(
    state.apiCalls.filter((call) => /prepared-menus|approvals|publications/.test(call.path)),
  ).toEqual([]);
});

test('a response for another actor never opens its restaurant', async ({ context, page }) => {
  const state = await fixture(context);
  state.invalidActor = true;
  await signIn(page, undefined, false);
  await expect(
    page.getByRole('heading', { name: 'Restaurant workspace unavailable' }),
  ).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
});

test('report revocation refreshes membership and clears private state', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-shell')).toBeVisible();
  state.reportStatus = 403;
  state.venues = [];
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No restaurant access yet' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('an expired identity removes the shell before an API request can use it', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload saved work', exact: true })).toBeVisible();
  const beforeExpiry = [...state.apiCalls];
  state.denyIdentity = true;
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
  expect(state.apiCalls).toEqual(beforeExpiry);
});

test('sign-out while membership is pending cannot restore a late restaurant response', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.delayMembership = true;
  await signIn(page, undefined, false);
  await expect.poll(() => state.apiCalls.length).toBeGreaterThan(0);
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  state.releaseMembership();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
});

test('a different account signing in in another tab replaces old state and a late report', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-identity__name')).toHaveText(venue.name);
  state.delayReport = true;
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect
    .poll(() => state.apiCalls.some((call) => call.path.endsWith('/analytics/dishes')))
    .toBe(true);
  const other = await context.newPage();
  await other.goto(origin);
  expect(
    await other.evaluate(async () => {
      const path = '/src/auth/supabase-auth.ts';
      const { connectOwnerAuth } = await import(path);
      const auth = connectOwnerAuth({
        url: 'https://auth-fixture.supabase.co',
        publishableKey: 'sb_publishable_synthetic_fixture_only',
        confirmationUrl: `${location.origin}/auth-confirm.html`,
      });
      return (
        await auth.service.signIn({ email: 'other@example.test', password: 'synthetic-password' })
      ).kind;
    }),
  ).toBe('signed_in');
  await expect(page.locator('.owner-identity__name')).toHaveText(otherVenue.name);
  state.releaseReport();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: venue.name })).toHaveCount(0);
});

test('SDK refresh supplies the new actor-bound token without keeping expired access', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-shell')).toBeVisible();
  const before = state.tokenVersion;
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.endsWith('-auth-token'));
    if (!key) throw new Error('Synthetic SDK session missing');
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.expires_at = Math.floor(Date.now() / 1000) - 120;
    localStorage.setItem(key, JSON.stringify(stored));
  });
  await openAccount(page);
  await page.getByRole('button', { name: 'Refresh access', exact: true }).click();
  await expect.poll(() => state.tokenVersion).toBeGreaterThan(before);
  await expect(page.locator('.owner-identity__name')).toHaveText(venue.name);
  expect(state.apiCalls.at(-1)?.version).toBe(state.tokenVersion);
});

test('late identity restoration cannot reopen a workspace after another tab signs out', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-shell')).toBeVisible();
  const before = state.identityRequests;
  state.delayIdentity = true;
  await page.reload();
  await expect.poll(() => state.identityRequests).toBeGreaterThan(before);
  const other = await context.newPage();
  await other.goto(origin);
  expect(
    await other.evaluate(async () => {
      const path = '/src/auth/supabase-auth.ts';
      const { connectOwnerAuth } = await import(path);
      const auth = connectOwnerAuth({
        url: 'https://auth-fixture.supabase.co',
        publishableKey: 'sb_publishable_synthetic_fixture_only',
        confirmationUrl: `${location.origin}/auth-confirm.html`,
      });
      return await auth.signOut();
    }),
  ).toBe(true);
  state.delayIdentity = false;
  state.releaseIdentity();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
});

test('workspace supports keyboard, narrow screens and accessible labels', async ({
  context,
  page,
}, testInfo) => {
  await fixture(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(page.locator('.owner-shell')).toBeVisible();
  // WCAG 1.4.3 exempts logotypes; retain the authored orange wordmark.
  const axe = await new AxeBuilder({ page }).exclude('.owner-brand__name').analyze();
  expect(axe.violations).toEqual([]);
  await openAccount(page);
  await page.getByLabel('Restaurant', { exact: true }).focus();
  await expect(page.getByLabel('Restaurant', { exact: true })).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('owner-workspace-mobile.png'),
    fullPage: true,
  });
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    elements: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth)
      .map((element) => element.className)
      .slice(0, 12),
  }));
  expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
});

test('the AI panel opens beside the live report and uses only the signed-in owner and restaurant', async ({
  context,
  page,
}, testInfo) => {
  const state = await fixture(context);
  await signIn(page);
  await expect(page.locator('.owner-identity__name')).toHaveText(venue.name);
  await expect(page.getByRole('complementary', { name: 'PeekaPlate AI' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  await expect(panel).toBeVisible();
  const dish = panel.getByLabel('Dish', { exact: true });
  await expect(dish.locator('option')).toHaveText(UNEEZA_REPORT.dishes.map((d) => d.name));
  await dish.selectOption({ label: 'Soup' });
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: 'Suggested review' })).toBeVisible();
  const soup = UNEEZA_REPORT.dishes.find((d) => d.name === 'Soup');
  expect(state.analyses).toEqual([
    { venueId: venue.venueId, actor: ownerId, body: { dishId: soup?.dish_id, goal: 'menu' } },
  ]);
  const axe = await new AxeBuilder({ page }).exclude('.owner-brand__name').analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('owner-workspace-ai.png'), fullPage: true });
  await page.getByRole('button', { name: 'Restaurant Setup', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'PeekaPlate AI' })).toHaveCount(0);
});

test('switching restaurant clears the AI result and asks only for the new restaurant', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.venues = [venue, otherVenue];
  await signIn(page, undefined, false);
  await openAccount(page);
  await page.getByLabel('Restaurant', { exact: true }).selectOption(venue.venueId);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: 'Suggested review' })).toBeVisible();
  await openAccount(page);
  await page.getByLabel('Restaurant', { exact: true }).selectOption(otherVenue.venueId);
  await expect(page.getByRole('heading', { name: 'Suggested review' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(panel.getByText(otherVenue.name)).toBeVisible();
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: 'Suggested review' })).toBeVisible();
  expect(state.analyses.map((call) => call.venueId)).toEqual([venue.venueId, otherVenue.venueId]);
});

test('editor access shows no AI panel', async ({ context, page }) => {
  const state = await fixture(context);
  state.venues = [{ ...venue, permission: 'editor' }];
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your dishes' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'PeekaPlate AI' })).toHaveCount(0);
  expect(state.analyses).toEqual([]);
});

test('the AI panel shows the report period and an honest error when the review fails', async ({
  context,
  page,
}) => {
  await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  await expect(panel.getByText('No questions yet')).toBeVisible();
  await expect(panel.getByText(/Oct 19\s*–\s*20, 2026/)).toBeVisible();
  await context.route(`${api}/api/v1/venues/*/ai/analysis`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'unavailable' },
      headers: { 'Access-Control-Allow-Origin': origin },
    }),
  );
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'The report could not be reviewed. Check your session or try again later.',
  );
  await expect(panel.getByRole('heading', { name: /Suggested review/ })).toHaveCount(0);
});

test('analysis denial clears the private report and refreshes restaurant access', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  await expect(panel).toBeVisible();
  state.analysisStatus = 403;
  state.venues = [];
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(page.getByRole('heading', { name: 'No restaurant access yet' })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('the panel distinguishes its server-read analysis period from the displayed report', async ({
  context,
  page,
}) => {
  await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: /Suggested review/ })).toBeVisible();
  await expect(panel.getByText(/Displayed report period:.*Oct 19\s*–\s*20, 2026/)).toBeVisible();
  await expect(panel.getByText(/Analysis evidence period:.*Nov 11\s*–\s*12, 2026/)).toBeVisible();
  await expect(
    panel.getByText('Synthetic analysis from a separate server-read snapshot.'),
  ).toBeVisible();
  await expect(panel.getByText(/Answers use only the records shown/)).toHaveCount(0);
});

test('a pending analysis cannot restore private output after sign-out and another account signs in', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.delayAnalysis = true;
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('status')).toHaveText('Reviewing the report…');
  await expect.poll(() => state.analyses.length).toBe(1);
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  await signIn(page, 'other@example.test');
  await expect(page.locator('.owner-identity__name')).toHaveText(otherVenue.name);
  state.releaseAnalysis();
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  await expect(panel.getByText('No questions yet')).toBeVisible();
  await expect(panel.getByRole('heading', { name: /Suggested review/ })).toHaveCount(0);
  expect(state.analyses.map((call) => call.actor)).toEqual([ownerId]);
});

test('the live owner AI panel stays usable on mobile with accessible controls', async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: /Suggested review/ })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    elements: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth)
      .map((element) => element.className)
      .slice(0, 12),
  }));
  expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
  expect((await new AxeBuilder({ page }).include('.owner-ai').analyze()).violations).toEqual([]);
});
