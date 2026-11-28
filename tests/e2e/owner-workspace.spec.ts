import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { OwnerDishFields, RestaurantProfile } from '@peekaplate/contracts';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { UNEEZA_REPORT } from '../../frontend/console/src/owner-dashboard/uneeza-report';
import type { DishDraft, MenuJob } from '../../frontend/console/src/owner-menu/api';
import { JOB, reviewSession } from '../../frontend/console/src/owner-menu/fixtures.test-helpers';
import { OwnerDishReportSchema } from '../../packages/contracts/src/owner-report';

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

const reportReference = (actor: string, venueId: string) =>
  `synthetic-report-reference.${actor}.${venueId}`;

async function fixture(context: BrowserContext, reportReady = false) {
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
    profiles: {} as Record<string, RestaurantProfile>,
    afterVerification: null as ((draft: DishDraft) => void) | null,
    profileStatus: 200,
    delayProfileSave: false,
    profileSaveStarted: false,
    releaseProfileSave: () => {},
    setupStatus: 200,
    delaySetup: false,
    releaseSetup: () => {},
    delayProfilePhoto: false,
    releaseProfilePhoto: () => {},
    jobs: {} as Record<string, MenuJob[]>,
    groups: new Map<string, { jobs: MenuJob[]; hashes: string[] }>(),
    photos: new Map<string, Buffer>(),
    unavailableDraftPhoto: null as string | null,
    receipts: new Map<string, unknown>(),
    conflictSave: false,
    verificationStatus: 200,
    verificationCommands: [] as string[],
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
    reviewServiceStatus: 200,
    releaseReview: () => {},
    delayMembership: false,
    releaseMembership: () => {},
    delayReport: false,
    releaseReport: () => {},
    apiCalls: [] as Array<{ path: string; actor: string; version: number }>,
    analyses: [] as Array<{ venueId: string; actor: string; body: unknown; reference?: string }>,
    analysisStatus: 200,
    delayAnalysis: false,
    releaseAnalysis: () => {},
    // The analysis snapshot period; by default the same as the report on screen (UNEEZA_REPORT).
    analysisWindow: { start: '2026-10-19T07:00:00Z', end: '2026-10-20T07:00:00Z' },
  };
  // Reporting journeys start with saved, verified dishes. Empty/unverified setup tests keep
  // the default fixture; verification does not imply approval or publication.
  if (reportReady) {
    for (const restaurant of [venue, otherVenue]) {
      const id = crypto.randomUUID();
      const photoId = crypto.randomUUID();
      state.photos.set(
        photoId,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      state.drafts[restaurant.venueId] = [
        {
          id,
          draft_id: id,
          job_id: null,
          origin: 'manual',
          draft_version: 1,
          name: 'Fictional Lentil Soup',
          category: 'Soup',
          description: 'Slow cooked lentil soup with herbs.',
          price_amount: '9.50',
          price_currency: 'USD',
          ingredients: ['lentils'],
          source_text: null,
          review_warnings: [],
          review_status: 'pending',
          verification_status: 'verified',
          manual_fields: {
            name: 'Fictional Lentil Soup',
            category: 'Soup',
            description: 'Slow cooked lentil soup with herbs.',
            priceAmount: '9.50',
            priceCurrency: 'USD',
            servingSize: '1 bowl',
            servingCount: 1,
            ingredients: { status: 'confirmed', items: ['lentils'] },
            allergens: { status: 'confirmed', items: [] },
            photoId,
          },
        },
      ];
    }
  }
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
      state.analyses.push({
        venueId: analysis[1] ?? '',
        actor,
        body,
        reference: request.headers()['x-owner-report-ref'],
      });
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
          timeWindow: state.analysisWindow,
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
      if (path === 'profile') {
        if (state.profileStatus !== 200)
          return route.fulfill({
            status: state.profileStatus,
            json: { error: 'unavailable' },
            headers,
          });
        if (request.method() === 'PUT') {
          state.profileSaveStarted = true;
          if (state.delayProfileSave)
            await new Promise<void>((resolve) => {
              state.releaseProfileSave = resolve;
            });
          const input = request.postDataJSON();
          if ((state.profiles[id]?.version ?? 0) !== input.expectedVersion)
            return route.fulfill({ status: 409, json: { error: 'version_conflict' }, headers });
          state.profiles[id] = {
            version: input.expectedVersion + 1,
            fields: input.fields,
            status: 'submitted',
          };
        }
        return route.fulfill({ json: { profile: state.profiles[id] ?? null }, headers });
      }
      if (path === 'setup') {
        if (state.delaySetup)
          await new Promise<void>((resolve) => {
            state.releaseSetup = resolve;
          });
        if (state.setupStatus !== 200)
          return route.fulfill({
            status: state.setupStatus,
            json: { error: 'forbidden' },
            headers,
          });
        const active = (state.drafts[id] ?? []).filter(
          (draft) => !draft.removed_at && !['rejected', 'superseded'].includes(draft.review_status),
        );
        return route.fulfill({
          json: {
            venueId: id,
            restaurantName:
              state.profiles[id]?.fields.name ??
              state.venues.find((venue) => venue.venueId === id)?.name ??
              otherVenue.name,
            detailsStatus: state.profiles[id]?.status ?? 'missing',
            menuAdded: active.length > 0,
            menuVerified:
              active.length > 0 &&
              active.every((draft) => draft.verification_status === 'verified'),
            published: false,
          },
          headers,
        });
      }
      if (path === 'menus/jobs') {
        state.jobsReads++;
        if (state.delayJobs)
          await new Promise<void>((resolve) => {
            state.releaseJobs = resolve;
          });
        return route.fulfill({ json: { jobs: state.jobs[id] ?? [] }, headers });
      }
      if (path === 'profile/photos') {
        const photoId = crypto.randomUUID();
        state.photos.set(photoId, request.postDataBuffer()!);
        return route.fulfill({ status: 201, json: { id: photoId }, headers });
      }
      if (/^profile\/photos\/[^/]+$/.test(path)) {
        if (state.delayProfilePhoto)
          await new Promise<void>((resolve) => {
            state.releaseProfilePhoto = resolve;
          });
        return route.fulfill({
          body: state.photos.get(path.split('/')[2]!)!,
          contentType: 'image/png',
          headers,
        });
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
        const job = state.jobs[id]?.find((value) => value.id === path.split('/')[2]);
        if (job && !['complete', 'incomplete'].includes(job.status))
          return route.fulfill({ status: 409, json: { error: 'review_not_ready' }, headers });
        if (state.reviewServiceStatus !== 200)
          return route.fulfill({
            status: state.reviewServiceStatus,
            json: { error: 'artifact_unavailable' },
            headers,
          });
        if (state.delayReview)
          await new Promise<void>((resolve) => {
            state.releaseReview = resolve;
          });
        return route.fulfill({ json: state.review, headers });
      }
      if (/^menus\/jobs\/[^/]+\/(retry|cancel)$/.test(path)) {
        const job = state.jobs[id]!.find((value) => value.id === path.split('/')[2])!;
        job.status = path.endsWith('/retry') ? 'queued' : 'cancelled';
        if (path.endsWith('/retry')) {
          job.max_attempts = Math.max(job.max_attempts, job.attempt_count + 3);
          job.error_code = null;
        }
        return route.fulfill({ json: { job }, headers });
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
        const linked = state.drafts[id]?.find((draft) => draft.candidate_id === candidateId);
        if (linked && linked.review_status === 'pending') {
          linked.draft_version = (linked.draft_version ?? 0) + 1;
          linked.verification_status = 'not_verified';
        }
        return route.fulfill({ json: item, headers });
      }
      if (path === 'drafts')
        return route.fulfill({ json: { drafts: state.drafts[id] ?? [] }, headers });
      if (/^drafts\/[^/]+\/removal$/.test(path)) {
        const input = request.postDataJSON();
        const draft = state.drafts[id]?.find((row) => row.id === path.split('/')[1]);
        if (
          !draft ||
          draft.draft_version !== input.expectedDraftVersion ||
          (draft.removal_version ?? 0) !== input.expectedRemovalVersion
        )
          return route.fulfill({ status: 409, json: { error: 'version_conflict' }, headers });
        draft.removal_version = input.expectedRemovalVersion + 1;
        draft.removed_at = input.removed ? new Date().toISOString() : null;
        return route.fulfill({ json: { draft }, headers });
      }
      if (/^drafts\/[^/]+\/verify$/.test(path)) {
        const input = request.postDataJSON();
        state.verificationCommands.push(input.commandId);
        const draft = state.drafts[id]?.find((draft) => draft.id === path.split('/')[1]);
        if (state.verificationStatus !== 200)
          return route.fulfill({
            status: state.verificationStatus,
            json: { error: 'version_conflict' },
            headers,
          });
        if (!draft || draft.draft_version !== input.expectedVersion)
          return route.fulfill({ status: 409, json: { error: 'version_conflict' }, headers });
        draft.verification_status = 'verified';
        state.afterVerification?.(draft);
        return route.fulfill({ json: { draft }, headers });
      }
      if (/^drafts\/[^/]+\/photos\/[^/]+\/approve$/.test(path)) {
        const photoId = path.split('/')[3]!;
        return route.fulfill({
          json: {
            photo: {
              id: photoId,
              draftId: path.split('/')[1],
              contentType: 'image/png',
              sizeBytes: 4,
              sha256: 'a'.repeat(64),
              verificationStatus: 'verified',
              storageKey: 'synthetic/approved.png',
            },
          },
          headers,
        });
      }
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
      if (/^drafts\/[^/]+\/photos\/[^/]+$/.test(path)) {
        const photoId = path.split('/')[3]!;
        if (photoId === state.unavailableDraftPhoto)
          return route.fulfill({ status: 503, json: { error: 'unavailable' }, headers });
        return route.fulfill({
          body: state.photos.get(photoId)!,
          contentType: 'image/png',
          headers,
        });
      }
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
      if (request.method() === 'GET' && /^drafts\/[^/]+\/photos\/[^/]+\/portion$/.test(path))
        return route.fulfill({ status: 404, json: { error: 'not_found' }, headers });
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
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Expose-Headers': 'X-Owner-Report-Ref',
          'X-Owner-Report-Ref': reportReference(actor, url.pathname.split('/')[4]!),
        },
      });
    }
  });
  return state;
}

async function acknowledgeDish(page: Page) {
  const review = page.getByRole('checkbox', {
    name: /I reviewed the AI-drafted text and ingredients/,
  });
  if (await review.isVisible()) await review.check();
  const license = page.getByRole('checkbox', {
    name: 'I have the right to use this photo.',
  });
  if (await license.isVisible()) await license.check();
}

// Fill the additional fields required by the authored S09, without replacing values under test.
async function completeRequiredDish(page: Page) {
  const serving = page.getByRole('spinbutton', { name: 'Serving size (people)', exact: true });
  if (!(await serving.inputValue())) await serving.fill('1');
  const price = page.getByRole('textbox', { name: /^Price/ });
  if (!(await price.inputValue())) await price.fill('9.50');
  const category = page.getByRole('combobox', { name: 'Category' });
  if ((await category.innerText()).includes('Select category')) await addCategory(page, 'Soup');
  if (!(await page.getByRole('list', { name: 'Ingredients', exact: true }).count())) {
    await page.getByRole('textbox', { name: /^Ingredients/ }).fill('Lentils');
    await page.getByRole('button', { name: 'Add ingredient', exact: true }).click();
  }
  if (!(await page.getByRole('img', { name: 'Private draft dish' }).count())) {
    await page.getByLabel('Dish photo', { exact: true }).setInputFiles({
      name: 'synthetic.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
  }
  await acknowledgeDish(page);
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

test('staging workspace does not resume a production deep link after sign-in', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
  await page.goto(`${origin}/dish-performance`);
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page).toHaveURL(`${origin}/dish-performance`);
  await page.getByLabel('Email address').fill('owner@example.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', {
      name: 'Restaurant Setup',
    }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(`${origin}/dish-performance`);
  expect(state.apiCalls.some((call) => call.path.endsWith('/analytics/dishes'))).toBe(false);
});

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

async function preparedPublication(context: BrowserContext, privatePhotos = false) {
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
    url: privatePhotos
      ? `${api}/public/prepared-assets/${venue.venueId}/${id(6)}/${'c'.repeat(64)}`
      : 'https://68d424e7.peekaplate-diner-staging.pages.dev/fixtures/synthetic.webp',
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
    prepares: 0,
    previewPhotoReads: 0,
    previewPhotoAuth: [] as string[],
    publicPhotoReads: 0,
    prepareFailure: false as false | 'unavailable' | 'menu_not_verified' | 'not_found',
    historicalFirst: false,
    preparedMatch: 'exact' as 'exact' | 'missing' | 'ambiguous',
    previewRequests: [] as string[],
    preparedMenu: menu,
  };
  const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*' };
  await context.route('**/venues/*/prepared-menus**', async (route) => {
    if (state.denied) return route.fulfill({ status: 403, json: { error: 'forbidden' }, headers });
    if (privatePhotos && new URL(route.request().url()).pathname.includes('/assets/')) {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: {
            ...headers,
            'Access-Control-Allow-Methods': 'GET',
            'Access-Control-Allow-Headers': 'Authorization',
          },
        });
      state.previewPhotoReads += 1;
      state.previewPhotoAuth.push(route.request().headers().authorization ?? '');
      return route.fulfill({
        headers,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhNsAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    }
    // Part A: opening S13 (and Prepare again) prepares first; preparing never publishes.
    if (new URL(route.request().url()).pathname.endsWith('/prepared-menus/prepare')) {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: { ...headers, 'Access-Control-Allow-Methods': 'POST' },
        });
      state.prepares += 1;
      return state.prepareFailure
        ? route.fulfill({
            status:
              state.prepareFailure === 'menu_not_verified'
                ? 409
                : state.prepareFailure === 'not_found'
                  ? 404
                  : 503,
            json: { error: state.prepareFailure },
            headers,
          })
        : route.fulfill({
            json: {
              menuId: menu.menuId,
              menuRevisionId: menu.menuRevisionId,
              completeDishes: 1,
              diagnostics: [],
              status: 'already_present',
            },
            headers,
          });
    }
    const liveMenu = {
      ...menu,
      publicationVersion: state.publicationVersion,
      publishedRevisionId: state.publicationVersion ? menu.menuRevisionId : null,
    };
    const historical = {
      ...menu,
      menuRevisionId: id(8),
      publishedRevisionId: id(8),
      publicationVersion: 1,
    };
    const menus =
      state.preparedMatch === 'missing'
        ? [historical]
        : state.preparedMatch === 'ambiguous'
          ? [liveMenu, { ...liveMenu }]
          : state.historicalFirst
            ? [historical, liveMenu]
            : [liveMenu];
    if (!new URL(route.request().url()).pathname.endsWith('prepared-menus')) {
      const path = new URL(route.request().url()).pathname;
      state.previewRequests.push(path);
      const selected = menus.find((item) =>
        path.endsWith(`/${item.menuId}/${item.menuRevisionId}`),
      );
      if (!selected) return route.fulfill({ status: 404, json: { error: 'not_found' }, headers });
      return route.fulfill({
        json: {
          menu: selected,
          content: {
            ...content,
            menu_id: selected.menuId,
            menu_revision_id: selected.menuRevisionId,
          },
        },
        headers,
      });
    }
    return route.fulfill({
      json: { menus },
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
  await context.route(photo.url, (route) => {
    if (privatePhotos) {
      state.publicPhotoReads += 1;
      return route.fulfill({ status: 404, json: { error: 'not_found' }, headers });
    }
    return route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhNsAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  // After publishing, the S13 phone frames the returned diner page; answer it locally.
  await context.route('https://routing-staging.peekaplate-diner-staging.pages.dev/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Diner</title><h1>Synthetic Bridge Cafe diner menu</h1>',
    }),
  );
  return state;
}

test('private prepared photos use owner-authenticated blobs and are revoked on leaving preview', async ({
  context,
  page,
}) => {
  await fixture(context);
  const state = await preparedPublication(context, true);
  await page.addInitScript(() => {
    const old = URL.revokeObjectURL;
    (window as unknown as { revokedPhotos: string[] }).revokedPhotos = [];
    URL.revokeObjectURL = (url) => {
      (window as unknown as { revokedPhotos: string[] }).revokedPhotos.push(url);
      old.call(URL, url);
    };
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Review and publish', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preview your menu', exact: true })).toBeVisible();
  const image = page.getByRole('img', { name: 'Labelled synthetic test image' });
  await expect(image).toBeVisible();
  const blob = await image.getAttribute('src');
  expect(blob).toMatch(/^blob:/);
  expect(state.previewPhotoReads).toBe(1);
  expect(state.previewPhotoAuth.every((value) => value.startsWith('Bearer '))).toBe(true);
  expect(state.publicPhotoReads).toBe(0);
  expect(state.approvals).toHaveLength(0);
  expect(state.publishes).toHaveLength(0);
  await page.getByRole('button', { name: 'Back to Edit', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (url) => (window as unknown as { revokedPhotos: string[] }).revokedPhotos.includes(url!),
        blob,
      ),
    )
    .toBe(true);
});

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
    await expect(
      page.getByRole('heading', { name: 'Preview your menu', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Synthetic Garden Soup' })).toBeVisible();
    await expect(
      page.getByText('Fictional soup used only for testing.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('CA$8.50')).toBeVisible();
    await page.getByText('Ingredients and allergens', { exact: true }).click();
    await expect(page.getByText('Allergen information not provided.')).toBeVisible();
    expect(state.approvals).toHaveLength(0);
    expect(state.publishes).toHaveLength(0);
    await page.locator('.pp-menu-preview__screen').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: testInfo.outputPath('s13-prepared-preview.png'),
      fullPage: true,
    });
    expect(
      (await new AxeBuilder({ page }).include('.pp-menu-preview').analyze()).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Publish Menu', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('s13-publish-confirmation.png'),
      fullPage: true,
    });
    await page.getByRole('dialog').getByRole('button', { name: 'Publish Menu' }).click();
    await expect(page.getByRole('heading', { name: 'Your menu is live' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Menu link' })).toHaveValue(
      'https://routing-staging.peekaplate-diner-staging.pages.dev/diner/synthetic-bridge-cafe',
    );
    // The phone now shows the real diner page at the returned link.
    await expect(page.locator('iframe.pp-menu-preview__frame')).toHaveAttribute(
      'src',
      'https://routing-staging.peekaplate-diner-staging.pages.dev/diner/synthetic-bridge-cafe',
    );
    expect(state.approvals).toHaveLength(1);
    expect(state.publishes).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath('s13-published-link.png'), fullPage: true });
    // Figma S13: after publishing, the only action is Go to dashboard.
    await page.getByRole('button', { name: 'Go to dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Your menu is live' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('button', { name: 'Review and publish' }).click();
    await expect(page.getByRole('heading', { name: 'Your menu is live' })).toBeVisible();
    expect(state.publishes).toHaveLength(1);
  });
}

test('preparation opens its exact snapshot after an older published entry without a chooser or publication', async ({
  context,
  page,
}) => {
  await fixture(context);
  const state = await preparedPublication(context);
  state.historicalFirst = true;
  await signIn(page);
  await page.getByRole('button', { name: 'Review and publish', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preview your menu', exact: true })).toBeVisible();
  const draftMenu = page.getByRole('region', { name: 'Draft diner menu' });
  await expect(draftMenu.getByRole('heading', { name: 'Synthetic Garden Soup' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Preview prepared menu/ })).toHaveCount(0);
  expect(state.previewRequests).toEqual([
    `/venues/${venue.venueId}/prepared-menus/${state.preparedMenu.menuId}/${state.preparedMenu.menuRevisionId}`,
  ]);
  expect(state.prepares).toBe(1);
  expect(state.approvals).toEqual([]);
  expect(state.publishes).toEqual([]);
});

for (const outcome of ['not_found', 'missing', 'ambiguous'] as const) {
  test(`preparation preserves explicit selection when its result is ${outcome}`, async ({
    context,
    page,
  }) => {
    await fixture(context);
    const state = await preparedPublication(context);
    if (outcome === 'not_found') state.prepareFailure = outcome;
    else state.preparedMatch = outcome;
    await signIn(page);
    await page.getByRole('button', { name: 'Review and publish', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Prepared menus' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Preview prepared menu/ }).first()).toBeVisible();
    await expect(page.locator('.pp-menu-preview__phone')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Publish Menu', exact: true })).toHaveCount(0);
    expect(state.previewRequests).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(state.publishes).toEqual([]);
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
  await expect(page.getByRole('heading', { name: 'Preview your menu', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Publish Menu', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish Menu' }).click();
  await expect(page.getByRole('alert')).toContainText('We couldn’t publish your menu');
  state.linkFailure = true;
  await page.getByRole('button', { name: 'Publish Menu', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish Menu' }).click();
  await expect(page.getByRole('button', { name: 'Get diner link' })).toBeVisible();
  expect(state.approvals[1]).toEqual(state.approvals[0]);
  state.linkFailure = false;
  await page.getByRole('button', { name: 'Get diner link' }).click();
  await expect(page.getByRole('textbox', { name: 'Menu link' })).toHaveValue(/routing-staging/);
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
  await expect(page.getByRole('heading', { name: 'Preview your menu', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Publish Menu', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish Menu' }).click();
  await expect(
    page.getByText('The menu changed. Prepare again and review it again before publishing.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish Menu', exact: true })).toHaveCount(0);
  state.denied = true;
  await page.getByRole('button', { name: 'Prepare again' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Garden Soup' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Menu link' })).toHaveCount(0);
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

test('saved dish photos replace the menu icon in the menu table, read as private blobs', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
  const drafts = state.drafts[venue.venueId]!;
  const original = drafts[0]!;
  const firstPhoto = original.manual_fields!.photoId!;
  const lastPhoto = crypto.randomUUID();
  state.photos.set(lastPhoto, state.photos.get(firstPhoto)!);
  state.unavailableDraftPhoto = firstPhoto;
  for (let index = 0; index < 20; index++) {
    const id = crypto.randomUUID();
    const name = index === 19 ? 'Fictional Dessert' : `Fictional Salad ${index + 1}`;
    drafts.push({
      ...original,
      id,
      draft_id: id,
      name,
      manual_fields: { ...original.manual_fields!, name, photoId: index === 19 ? lastPhoto : null },
    });
  }
  const photoReads = () => state.apiCalls.filter((call) => call.path.includes('/photos/'));
  await signIn(page, undefined, false);
  await expect(page.getByRole('heading', { name: 'Welcome to PeekaPlate' })).toBeVisible();
  expect(photoReads()).toHaveLength(0);
  const failedPhoto = page.waitForResponse(
    (response) => response.url().endsWith(`/photos/${firstPhoto}`) && response.status() === 503,
  );
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const withPhoto = page.locator('.mrow').filter({ hasText: 'Fictional Lentil Soup' });
  await failedPhoto;
  await expect(withPhoto.locator('.thumb .ic')).toBeVisible();
  state.unavailableDraftPhoto = null;
  await page.getByRole('button', { name: 'Reload saved work', exact: true }).click();
  const photo = withPhoto.locator('.thumb img');
  await expect(photo).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  const noPhoto = page
    .locator('.mrow')
    .filter({ has: page.getByRole('button', { name: 'Edit Fictional Salad 1', exact: true }) });
  await expect(noPhoto.locator('.thumb .ic')).toBeVisible();
  const belowFold = page.locator('.mrow').filter({ hasText: 'Fictional Dessert' });
  await expect(belowFold).not.toBeInViewport();
  expect(photoReads()).toHaveLength(2);
  expect(photoReads()[0]?.actor).toBe(ownerId);
  await belowFold.scrollIntoViewIfNeeded();
  await expect(belowFold.locator('.thumb img')).toHaveAttribute('src', /^blob:/);
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
    'Verify every saved dish to open the dashboard. Publication remains a separate step.',
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

test('live image source previews decode and release their blobs on replace, remove and sign-out', async ({
  context,
  page,
}) => {
  await fixture(context);
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL.bind(URL);
    (window as unknown as { revokedSourceUrls: string[] }).revokedSourceUrls = [];
    URL.revokeObjectURL = (url) => {
      (window as unknown as { revokedSourceUrls: string[] }).revokedSourceUrls.push(url);
      original(url);
    };
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
  await page.getByText('Upload photos/PDF', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const image = {
    name: 'source.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
      'base64',
    ),
  };
  const upload = async (name: string) => {
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({ ...image, name });
    const preview = page.getByRole('img', { name: `Preview of ${name}`, exact: true });
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    return (await preview.getAttribute('src'))!;
  };
  const revoked = (url: string) =>
    page.evaluate(
      (value) =>
        (window as unknown as { revokedSourceUrls: string[] }).revokedSourceUrls.includes(value),
      url,
    );
  const first = await upload('source.png');
  expect(first).toMatch(/^blob:/);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Replace source.png', exact: true }).click(),
  ]);
  await chooser.setFiles({ ...image, name: 'replacement.png' });
  const replacement = page.getByRole('img', { name: 'Preview of replacement.png', exact: true });
  await expect(replacement).toBeVisible();
  await expect.poll(() => revoked(first)).toBe(true);
  const second = (await replacement.getAttribute('src'))!;
  await page.getByRole('button', { name: 'Remove replacement.png', exact: true }).click();
  await expect(replacement).toHaveCount(0);
  await expect.poll(() => revoked(second)).toBe(true);
  const last = await upload('final.png');
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect.poll(() => revoked(last)).toBe(true);
});

test('leaving an image selection ignores delayed group creation', async ({ context, page }) => {
  const state = await fixture(context);
  let started = false;
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  await page.route('**/upload-groups', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    started = true;
    await waiting;
    await route.fallback();
    finished = true;
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
  await page.getByText('Upload photos/PDF', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  try {
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: 'pending.png',
        mimeType: 'image/png',
        buffer: Buffer.from('synthetic pending source'),
      });
    await expect.poll(() => started).toBe(true);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Choose how to add your menu', exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
  await expect.poll(() => finished).toBe(true);
  await expect.poll(() => state.jobs[venue.venueId]?.length).toBe(1);
  expect(state.jobs[venue.venueId]?.[0]?.source_uploaded).toBe(false);
  await expect(page.locator('.pp-onboard-preview__image')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Choose how to add your menu', exact: true }),
  ).toBeVisible();
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
  await page.getByRole('textbox', { name: /^Dish name/ }).press('Enter');
  const category = page.getByRole('combobox', { name: /Category/ });
  await expect(category).toHaveAttribute('aria-describedby', 'f-cat-error');
  await expect(page.locator('#f-cat-error')).toHaveText('Error: Select a category');
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
    // The synthetic worker finishes without extracted dishes; the owner adds a manual dish next.
    // Pending extraction must never be used to unlock reporting.
    state.jobs[venue.venueId] = state.jobs[venue.venueId]!.map((job) => ({
      ...job,
      status: 'complete',
      started_at: '2026-11-15T00:00:01Z',
      finished_at: '2026-11-15T00:00:02Z',
    }));
    await page.getByRole('button', { name: 'View saved dishes', exact: true }).click();
    await page.getByRole('button', { name: 'Add dish', exact: true }).click();
    await capture('dish-empty');
    await page.getByRole('textbox', { name: /^Dish name/ }).fill('Fictional soup');
    await addCategory(page, 'Soup');
    await page.getByRole('textbox', { name: /^Price/ }).fill('9.50');
    await expect(page.getByRole('textbox', { name: /^Price \(USD\)/ })).toBeVisible();
    await acknowledgeDish(page);
    await completeRequiredDish(page);
    await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
    await expect(
      page.getByText('Draft saved. This has not approved or published your menu.'),
    ).toBeVisible();
    await capture('dish-saved');
    expect(state.verificationCommands).toEqual([]);
    await page.getByRole('button', { name: 'Complete verification', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Menu verified' })).toBeVisible();
    await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await capture('menu-saved');
    expect(state.apiCalls.some((call) => /publications|\/approvals$/.test(call.path))).toBe(false);
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

test('profile save reloads authenticated details and never verifies an owner submission', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page, undefined, false);
  await page.getByRole('button', { name: 'Start: Restaurant details', exact: true }).click();
  await page.getByRole('textbox', { name: /^Restaurant name/ }).fill('Ember & Stone');
  await page.getByRole('textbox', { name: /^City/ }).fill('San Francisco');
  await page.getByRole('textbox', { name: /^Street address/ }).fill('100 Fictional Street');
  await page.getByRole('textbox', { name: /^Phone number/ }).fill('(555) 234-5678');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.profiles[venue.venueId]?.version).toBe(1);
  expect(state.profiles[venue.venueId]?.status).toBe('submitted');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Welcome to PeekaPlate', exact: true }),
  ).toBeVisible();
  await openAccount(page);
  await page.getByRole('button', { name: 'Restaurant details', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Street address/ })).toHaveValue(
    '100 Fictional Street',
  );
  await page.getByRole('textbox', { name: /^Street address/ }).fill('101 Fictional Street');
  await openAccount(page);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Street address/ })).toHaveValue(
    '101 Fictional Street',
  );
  expect(state.profiles[venue.venueId]?.fields.street).toBe('100 Fictional Street');
  await openAccount(page);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Restaurant details', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Street address/ })).toHaveValue(
    '101 Fictional Street',
  );
  await openAccount(page);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Restaurant details', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Street address/ })).toHaveValue(
    '100 Fictional Street',
  );
});

test('a delayed profile save preserves navigation back to the dashboard', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.delayProfileSave = true;
  await signIn(page, undefined, false);
  await page.getByRole('button', { name: 'Start: Restaurant details', exact: true }).click();
  await page.getByRole('textbox', { name: /^Restaurant name/ }).fill('Ember & Stone');
  await page.getByRole('textbox', { name: /^City/ }).fill('San Francisco');
  await page.getByRole('textbox', { name: /^Street address/ }).fill('100 Fictional Street');
  await page.getByRole('textbox', { name: /^Phone number/ }).fill('(555) 234-5678');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.profileSaveStarted).toBe(true);
  await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
  state.releaseProfileSave();
  await expect(
    page.getByText(
      'Restaurant details saved and submitted for team verification. This does not publish your menu.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Welcome to PeekaPlate', exact: true }),
  ).toBeVisible();
  expect(state.profiles[venue.venueId]?.version).toBe(1);
});

test('a delayed restaurant photo does not reset unsaved restaurant details', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const photoId = crypto.randomUUID();
  state.profiles[venue.venueId] = {
    version: 1,
    status: 'submitted',
    fields: {
      name: 'Ember & Stone',
      city: 'San Francisco',
      street: '100 Fictional Street',
      line2: '',
      phone: '5552345678',
      email: '',
      photoId,
    },
  };
  state.photos.set(
    photoId,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  state.delayProfilePhoto = true;
  await signIn(page, undefined, false);
  await page.getByRole('button', { name: 'Edit: Restaurant details', exact: true }).click();
  await page.getByRole('textbox', { name: /^Street address/ }).fill('101 Fictional Street');
  await expect
    .poll(() => state.apiCalls.some((call) => call.path.endsWith(`/profile/photos/${photoId}`)))
    .toBe(true);
  state.releaseProfilePhoto();
  await expect(page.getByRole('img', { name: 'Restaurant logo', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Street address/ })).toHaveValue(
    '101 Fictional Street',
  );
});

test('metadata outage preserves menu work but a later sibling auth denial clears it', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.profileStatus = 503;
  state.setupStatus = 503;
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your dishes', exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Restaurant details and setup status are temporarily unavailable. Saved menu work remains available.',
    ),
  ).toBeVisible();
  state.setupStatus = 403;
  state.delaySetup = true;
  const before = state.apiCalls.filter((call) => call.path.endsWith('/setup')).length;
  await page.reload();
  await expect
    .poll(() => state.apiCalls.filter((call) => call.path.endsWith('/setup')).length)
    .toBeGreaterThan(before);
  state.venues = [];
  state.releaseSetup();
  await expect(page.getByRole('heading', { name: 'No restaurant access yet' })).toBeVisible();
  await expect(page.locator('.owner-shell')).toHaveCount(0);
});

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
  await expect(page.getByText('Not published', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('0 of 3 steps complete', { exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Start: Add your menu', exact: true }).click();
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

// Rania's #213 review: the live S09 opened from S06 returns to S06 (not the Menu list or S10),
// and each screen change moves focus to the new heading.
test('live Screen 9 opened from S06 goes Back to S06 and focus follows each screen', async ({
  context,
  page,
}) => {
  await fixture(context);
  await signIn(page, 'owner@example.test', false);
  await page.getByRole('button', { name: 'Start: Add your menu', exact: true }).click();
  const s06 = page.getByRole('heading', { level: 1, name: 'Choose how to add your menu' });
  await expect(s06).toBeFocused();
  await page.getByText('Add manually', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.s09-grid')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Add dish' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Continue to review', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(s06).toBeVisible();
  await expect(s06).toBeFocused();
});

test('manual dish and original private photo survive save and reload', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  await signIn(page);
  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  await page.getByRole('textbox', { name: /^Dish name/ }).fill('Fictional Lentil Soup');
  await addCategory(page, 'Soup');
  await page.getByRole('textbox', { name: /^Price/ }).fill('9.50');
  await expect(page.getByRole('textbox', { name: /^Price \(USD\)/ })).toBeVisible();
  const original = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page
    .getByLabel('Dish photo', { exact: true })
    .setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: original });
  await acknowledgeDish(page);
  await completeRequiredDish(page);
  await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
  await expect(
    page.getByText('Draft saved. This has not approved or published your menu.'),
  ).toBeVisible();
  expect([...state.photos.values()][0]).toEqual(original);
  expect(state.drafts[venue.venueId]?.[0]?.manual_fields).toMatchObject({
    allergens: { status: 'unknown', items: [] },
    servingSize: '1',
    servingCount: 1,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Fictional Lentil Soup', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Price/ })).toHaveValue('9.50');
  await page.getByRole('spinbutton', { name: 'Serving size (people)', exact: true }).fill('2');
  await acknowledgeDish(page);
  await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
  await expect(
    page.getByText('Draft saved. This has not approved or published your menu.'),
  ).toBeVisible();
  expect(state.drafts[venue.venueId]?.[0]?.manual_fields).toMatchObject({
    servingSize: '2',
    servingCount: 2,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Fictional Lentil Soup', exact: true }).click();
  await expect(
    page.getByRole('spinbutton', { name: 'Serving size (people)', exact: true }),
  ).toHaveValue('2');
  // Serving size is the only portion input; there is no separate people-served count.
  await expect(page.getByRole('spinbutton', { name: 'People served', exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Private draft dish' })).toBeVisible();
  const license = page.getByRole('checkbox', {
    name: 'I have the right to use this photo.',
  });
  const reviewed = page.getByRole('checkbox', {
    name: /I reviewed the AI-drafted text and ingredients/,
  });
  await expect(license).not.toBeChecked();
  await expect(reviewed).not.toBeChecked();
  await acknowledgeDish(page);
  await page
    .getByLabel('Dish photo', { exact: true })
    .setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: original });
  await expect(license).not.toBeChecked();
  await reviewed.check();
  await page.getByRole('textbox', { name: /^Dish name/ }).fill('Changed fictional soup');
  await expect(reviewed).not.toBeChecked();
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
  const menuUrl = page.getByLabel('Menu URL');
  await menuUrl.fill('https://restaurant.example/menu.pdf');
  await expect(menuUrl).toHaveCSS('padding-left', '44px');
  await expect(menuUrl).toHaveCSS('padding-right', '44px');
  await page.getByRole('button', { name: 'Import menu', exact: true }).click();
  await expect(page.getByText('Queued for processing', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View saved dishes', exact: true }).click();
  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add dish', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: /^Dish name/ }).fill('Fictional side salad');
  await acknowledgeDish(page);
  await completeRequiredDish(page);
  await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
  await expect(
    page.getByText('Draft saved. This has not approved or published your menu.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save and Exit', exact: true }).click();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
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
  await page.getByRole('textbox', { name: /^Dish name/ }).fill('Unsaved fictional soup');
  state.conflictSave = true;
  await acknowledgeDish(page);
  await completeRequiredDish(page);
  await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Saved data changed');
  await expect(page.getByRole('textbox', { name: /^Dish name/ })).toHaveValue(
    'Unsaved fictional soup',
  );
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
  await expect(page.getByRole('heading', { name: 'No dishes found', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View saved dishes', exact: true }).click();
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
    await acknowledgeDish(page);
    await completeRequiredDish(page);
    await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
    await expect(
      page.getByText('Draft saved. This has not approved or published your menu.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Save and Exit', exact: true }).click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
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
  await signIn(page);
  await expect(
    page.getByRole('button', { name: `Edit ${item.effective.name}`, exact: true }),
  ).toBeVisible();
  state.reviewStarted = false;
  state.delayReview = true;
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
  const state = await fixture(context, true);
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
  ).not.toHaveAttribute('aria-disabled', 'true');
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
  const state = await fixture(context, true);
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

test('created categories stay with their restaurant during a signed-in visit', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
  state.venues = [venue, otherVenue];
  await signIn(page, undefined, false);
  const openDish = async (restaurant: typeof venue) => {
    await openAccount(page);
    await page.getByLabel('Restaurant', { exact: true }).selectOption(restaurant.venueId);
    await expect(page.locator('.owner-identity__name')).toHaveText(restaurant.name);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  };
  const back = async () => {
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Back', exact: true }).click();
  };
  const category = 'Only in restaurant A';
  const option = page.getByRole('option', { name: category, exact: true });
  await openDish(venue);
  await addCategory(page, category);
  await back();
  await openDish(otherVenue);
  await page.getByRole('combobox', { name: 'Category' }).click();
  await expect(option).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Category' }).press('Escape');
  await back();
  await openDish(venue);
  await page.getByRole('combobox', { name: 'Category' }).click();
  await expect(option).toHaveCount(1);
});

test('editor access does not enable owner-only reports or publication', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
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
  const state = await fixture(context, true);
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
  const state = await fixture(context, true);
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
  const state = await fixture(context, true);
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
  const state = await fixture(context, true);
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
    {
      venueId: venue.venueId,
      actor: ownerId,
      body: { dishId: soup?.dish_id, goal: 'menu' },
      reference: reportReference(ownerId, venue.venueId),
    },
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
  const state = await fixture(context, true);
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
  const state = await fixture(context, true);
  state.venues = [{ ...venue, permission: 'editor' }];
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your dishes' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'PeekaPlate AI' })).toHaveCount(0);
  expect(state.analyses).toEqual([]);
});

test('the typed AI question displays its matching focus and rejects a different time window', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  const question = panel.getByRole('textbox', { name: 'Ask a report question' });
  await expect(panel.getByLabel('Review focus')).toHaveValue('menu');
  await question.fill('How is engagement for this dish?');
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: 'Suggested review' })).toBeVisible();
  expect(state.analyses[0]?.body).toMatchObject({ goal: 'engagement' });
  for (const unsupported of [
    'How was engagement yesterday?',
    'Show engagement on Monday',
    'Show menu engagement on November 18',
  ]) {
    await question.fill(unsupported);
    await panel.getByRole('button', { name: 'Review report' }).click();
    await expect(panel.getByRole('alert')).toContainText('The review uses the displayed dish');
    await expect(panel.getByRole('heading', { name: 'Suggested review' })).toHaveCount(0);
  }
  expect(state.analyses).toHaveLength(1);
});

test('the AI panel shows the report period and an honest error when the review fails', async ({
  context,
  page,
}) => {
  await fixture(context, true);
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

test('an analysis for a different period than the report on screen shows no suggestion', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
  // Deliberately different UTC start and end from the report on screen (Oct 19 07:00 – Oct 20 07:00).
  state.analysisWindow = { start: '2026-11-11T12:00:00Z', end: '2026-11-12T12:00:00Z' };
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: 'Different report period' })).toBeVisible();
  await expect(panel.getByText(/Nov 11\s*–\s*12, 2026/)).toBeVisible();
  // Honest guidance: no promise that refreshing and asking again will match.
  await expect(panel.getByText(/refresh/i)).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: /Suggested review/ })).toHaveCount(0);
  await expect(panel.getByText(/open rate/i)).toHaveCount(0);
  await expect(panel.getByText('Review the approved dish card', { exact: false })).toHaveCount(0);

  // Only the start differs: still no suggestion.
  state.analysisWindow = { start: '2026-10-19T06:00:00Z', end: '2026-10-20T07:00:00Z' };
  await panel.getByLabel('Review focus').selectOption('engagement');
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: 'Different report period' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: /Suggested review/ })).toHaveCount(0);

  // The real path: report and analysis each compute a rolling window from their own request time,
  // so an analysis requested 25 seconds later covers a shifted window. Still no suggestion, and
  // the message names both periods with exact times because their dates read the same.
  state.analysisWindow = { start: '2026-10-19T07:00:25Z', end: '2026-10-20T07:00:25Z' };
  await panel.getByLabel('Review focus').selectOption('crm');
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: 'Different report period' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: /Suggested review/ })).toHaveCount(0);
  await expect(panel.getByText(/Oct 19, 7:00:25\s*AM UTC/)).toBeVisible();
  await expect(panel.getByText(/Oct 19, 7:00:00\s*AM UTC/)).toBeVisible();

  // The same instants written differently (".000Z") count as the same period.
  state.analysisWindow = { start: '2026-10-19T07:00:00.000Z', end: '2026-10-20T07:00:00.000Z' };
  await panel.getByLabel('Review focus').selectOption('menu');
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: /Suggested review/ })).toBeVisible();
});

test('analysis denial clears the private report and refreshes restaurant access', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
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
  await fixture(context, true);
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'PeekaPlate AI' });
  await panel.getByRole('button', { name: 'Review report' }).click();
  await expect(panel.getByRole('heading', { name: /Suggested review/ })).toBeVisible();
  await expect(panel.getByText(/Displayed report period:.*Oct 19\s*–\s*20, 2026/)).toBeVisible();
  // A suggestion is shown only when the analysis covers the period on screen (see the next test
  // for a different period).
  await expect(panel.getByText(/Analysis evidence period:.*Oct 19\s*–\s*20, 2026/)).toBeVisible();
  await expect(
    panel.getByText('Synthetic analysis from a separate server-read snapshot.'),
  ).toBeVisible();
  await expect(panel.getByText(/Answers use only the records shown/)).toHaveCount(0);
});

test('a pending analysis cannot restore private output after sign-out and another account signs in', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
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
  await fixture(context, true);
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

test('authored S10 verifies actual saved drafts without publication and preserves command identity after conflict', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const id = crypto.randomUUID();
  const photoId = crypto.randomUUID();
  state.drafts[venue.venueId] = [
    {
      id,
      draft_id: id,
      job_id: null,
      origin: 'manual',
      draft_version: 1,
      name: 'Fictional Lentil Soup',
      category: 'Soup',
      description: 'Slow cooked lentil soup with herbs.',
      price_amount: '9.50',
      price_currency: 'CAD',
      ingredients: ['lentils'],
      source_text: null,
      review_warnings: [],
      review_status: 'pending',
      verification_status: 'not_verified',
      manual_fields: {
        name: 'Fictional Lentil Soup',
        category: 'Soup',
        description: 'Slow cooked lentil soup with herbs.',
        priceAmount: '9.50',
        priceCurrency: 'CAD',
        servingSize: '1 bowl',
        servingCount: 1,
        ingredients: { status: 'confirmed', items: ['lentils'] },
        allergens: { status: 'confirmed', items: [] },
        photoId,
      },
    },
  ];
  const second = structuredClone(state.drafts[venue.venueId]![0]!);
  second.id = crypto.randomUUID();
  second.draft_id = second.id;
  second.name = 'Fictional Salad';
  second.manual_fields!.name = second.name;
  state.drafts[venue.venueId]!.push(second);
  state.verificationStatus = 409;
  await signIn(page, undefined, false);
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Add your menu' })
    .getByRole('button', { name: 'Edit: Add your menu', exact: true })
    .click();
  await expect(page.locator('.review-table')).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);

  // The background refresh after a remove no longer locks the list (Adam's slow-delete finding):
  // while it is still running, the next remove and Undo work straight away.
  state.delayJobs = true;
  const jobsReadsBeforeRemoval = state.jobsReads;
  await page.getByRole('button', { name: 'Remove Fictional Salad', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await expect.poll(() => state.jobsReads).toBeGreaterThan(jobsReadsBeforeRemoval);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Remove Fictional Lentil Soup', exact: true }),
  ).toBeEnabled();
  state.delayJobs = false;
  state.releaseJobs();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Remove Fictional Salad', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Remove Fictional Salad', exact: true }).click();
  await expect
    .poll(
      () => state.drafts[venue.venueId]?.find((draft) => draft.id === second.id)?.removal_version,
    )
    .toBe(3);
  await expect(page.getByText('9.50 CAD', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Complete verification', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Saved data changed');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  state.verificationStatus = 200;
  await page.getByRole('button', { name: 'Complete verification', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Menu verified' })).toBeVisible();
  expect(state.verificationCommands).toHaveLength(2);
  expect(new Set(state.verificationCommands).size).toBe(1);
  expect(state.drafts[venue.venueId]?.[0]?.verification_status).toBe('verified');
  expect(state.apiCalls.some((call) => /\/photos\/[^/]+\/approve$/.test(call.path))).toBe(true);
  expect(
    state.apiCalls.some((call) =>
      /publications|\/approvals$|\/drafts\/[^/]+\/approve$/.test(call.path),
    ),
  ).toBe(false);
  await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Edit: Add your menu', exact: true }).click();
  state.afterVerification = (draft) => {
    draft.removed_at = new Date().toISOString();
    const replacement = structuredClone(draft);
    replacement.id = crypto.randomUUID();
    replacement.draft_id = replacement.id;
    replacement.removed_at = null;
    replacement.verification_status = 'not_verified';
    state.drafts[venue.venueId]!.push(replacement);
    state.afterVerification = null;
  };
  await page.getByRole('button', { name: 'Complete verification', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Saved data changed');
  await expect(page.getByRole('dialog', { name: 'Menu verified' })).toHaveCount(0);
  state.venues = [];
  state.menuStatus = 403;
  await page.getByRole('button', { name: 'Complete verification', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No restaurant access yet' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Menu verified' })).toHaveCount(0);
});

test('corrected extracted fields survive review return and a full reload', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const item = state.review.items[0]!;
  const id = crypto.randomUUID();
  state.drafts[venue.venueId] = [
    {
      id,
      draft_id: id,
      job_id: JOB,
      candidate_id: item.candidate.candidate_id,
      origin: 'extracted',
      draft_version: 1,
      name: item.effective.name,
      category: null,
      description: null,
      price_amount: null,
      price_currency: null,
      ingredients: null,
      source_text: 'Synthetic source',
      review_warnings: [],
      review_status: 'pending',
    },
  ];
  await signIn(page, undefined, false);
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Add your menu' })
    .getByRole('button', { name: 'Edit: Add your menu', exact: true })
    .click();
  await page.getByRole('button', { name: 'Review ' + item.effective.name, exact: true }).click();
  await page.getByRole('textbox', { name: /^Dish name/ }).fill('Corrected fictional soup');
  await addCategory(page, 'Seaweed specials');
  await page.getByRole('textbox', { name: /^Price/ }).fill('7.25');
  await expect(page.getByRole('textbox', { name: /^Price \(CAD\)/ })).toBeVisible();
  await acknowledgeDish(page);
  await completeRequiredDish(page);
  await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
  await expect(page.locator('.review-table')).toContainText('Corrected fictional soup');
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.locator('.mrow:not(.mhead)')).toContainText('Corrected fictional soup');
  await expect(page.locator('.mrow:not(.mhead)')).toContainText('7.25');
  expect(state.drafts[venue.venueId][0].name).not.toBe('Corrected fictional soup');
  expect(state.review.items[0].effective.name).toBe('Corrected fictional soup');
  expect(state.review.items[0].effective.category).toBe('Seaweed specials');
  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  await page.getByRole('combobox', { name: 'Category' }).click();
  await expect(page.getByRole('option', { name: 'Seaweed specials', exact: true })).toHaveCount(1);
});

test('an unready or unavailable extraction does not hide other saved work', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const item = state.review.items[0]!;
  const id = crypto.randomUUID();
  state.jobs[venue.venueId] = [
    {
      id: JOB,
      source_type: 'pdf',
      status: 'incomplete',
      attempt_count: 1,
      max_attempts: 3,
      error_code: null,
      draft_count: 1,
      created_at: '2026-11-15T00:00:00Z',
      started_at: null,
      finished_at: null,
    },
  ];
  state.drafts[venue.venueId] = [
    {
      id,
      draft_id: id,
      job_id: JOB,
      candidate_id: item.candidate.candidate_id,
      origin: 'extracted',
      draft_version: 1,
      name: item.effective.name,
      category: null,
      description: null,
      price_amount: null,
      price_currency: null,
      ingredients: null,
      source_text: 'Synthetic source',
      review_warnings: [],
      review_status: 'pending',
    },
  ];
  await signIn(page);
  await page.getByText('Saved sources (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Retry source', exact: true }).click();
  await expect(page.getByText('Queued for processing', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View saved dishes', exact: true }).click();
  await page.getByText('Saved sources (1)', { exact: true }).click();
  await expect(page.getByText('PDF source — queued; 1 dishes.')).toBeVisible();
  state.jobs[venue.venueId]![0]!.status = 'running';
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByText('Saved sources (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Cancel source', exact: true }).click();
  await expect(page.getByText('PDF source — cancelled; 1 dishes.')).toBeVisible();
  state.jobs[venue.venueId]![0]!.status = 'complete';
  state.reviewServiceStatus = 503;
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(
    page.getByText(
      'Some extracted reviews could not be loaded. Other saved dishes remain available. Reload after processing or recovery.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  await page.getByRole('textbox', { name: /^Dish name/ }).fill('Independent manual soup');
  await acknowledgeDish(page);
  await completeRequiredDish(page);
  await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
  await expect(
    page.getByText('Draft saved. This has not approved or published your menu.'),
  ).toBeVisible();
  expect(state.drafts[venue.venueId]).toHaveLength(2);
});

test('OCR processing waits for the remaining source files', async ({ context, page }) => {
  const state = await fixture(context);
  await page.clock.install();
  await signIn(page);
  await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
  await page.getByText('Paste URL', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Menu URL').fill('https://restaurant.example/menu.pdf');
  await page.getByRole('button', { name: 'Import menu', exact: true }).click();
  await expect(page.getByText('Queued for processing', { exact: true })).toBeVisible();
  state.jobs[venue.venueId]![0]!.source_uploaded = false;
  await page.clock.runFor(5000);
  await expect(
    page.getByText('Waiting for the remaining source files', { exact: true }),
  ).toBeVisible();
});

// Adapted from PR #207; current authored S09 fields and acknowledgements remain authoritative.
for (const outcome of ['complete', 'failed', 'incomplete'] as const) {
  test(`OCR ${outcome} with no new dishes is not success from older drafts`, async ({
    context,
    page,
  }) => {
    const state = await fixture(context);
    state.drafts[venue.venueId] = [
      {
        id: crypto.randomUUID(),
        draft_id: crypto.randomUUID(),
        job_id: 'older-job',
        origin: 'extracted',
        draft_version: 1,
        name: 'Older dish',
        category: null,
        description: null,
        price_amount: null,
        price_currency: null,
        ingredients: null,
        source_text: null,
        review_warnings: [],
        review_status: 'pending',
      },
    ];
    await page.clock.install();
    await signIn(page);
    await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
    await page.getByText('Paste URL', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Menu URL').fill('https://restaurant.example/menu.pdf');
    await page.getByRole('button', { name: 'Import menu', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Processing your menu' })).toBeVisible();
    const job = state.jobs[venue.venueId]![0]!;
    job.status = outcome;
    job.attempt_count = job.max_attempts;
    job.error_code = outcome === 'complete' ? null : 'extraction_failed';
    await page.clock.runFor(5000);
    await expect(
      page.getByRole('heading', {
        name: outcome === 'complete' ? 'No dishes found' : 'We couldn’t process your menu',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Try another source', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'View saved dishes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit Older dish', exact: true })).toBeVisible();
    await page.getByText('Saved sources (1)', { exact: true }).click();
    expect(state.apiCalls.some(({ path }) => /retry|approve|publish/.test(path))).toBe(false);
    if (outcome === 'complete') {
      await expect(page.getByRole('button', { name: 'Retry source', exact: true })).toHaveCount(0);
    } else {
      const jobId = job.id;
      await page.getByRole('button', { name: 'Retry source', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Processing your menu' })).toBeVisible();
      expect(state.jobs[venue.venueId]).toHaveLength(1);
      expect(job.id).toBe(jobId);
      expect(job.max_attempts).toBe(6);
      expect(state.apiCalls.filter(({ path }) => path.endsWith('/retry'))).toHaveLength(1);
    }
  });
}

for (const partial of [false, true]) {
  test(`OCR upload opens stored candidates for correction (${partial ? 'partial' : 'complete'})`, async ({
    context,
    page,
  }) => {
    const state = await fixture(context);
    await page.clock.install();
    await signIn(page);
    await page.getByRole('button', { name: 'Add menu sources', exact: true }).click();
    await page.getByText('Upload photos/PDF', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles([
        { name: 'menu.png', mimeType: 'image/png', buffer: Buffer.from('synthetic image one') },
        { name: 'menu-two.png', mimeType: 'image/png', buffer: Buffer.from('synthetic image two') },
      ]);
    await expect
      .poll(() => state.jobs[venue.venueId]?.every((job) => job.source_uploaded))
      .toBe(true);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Processing your menu' })).toBeVisible();
    const jobs = state.jobs[venue.venueId]!;
    const item = state.review.items[0]!;
    state.drafts[venue.venueId] = [
      {
        id: crypto.randomUUID(),
        draft_id: crypto.randomUUID(),
        job_id: jobs[0]!.id,
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
    jobs[0]!.status = 'complete';
    jobs[0]!.draft_count = 1;
    jobs[1]!.status = partial ? 'failed' : 'complete';
    await page.clock.runFor(5000);
    await expect(
      page.getByRole('button', { name: `Review ${item.effective.name}`, exact: true }),
    ).toBeVisible();
    if (partial) await expect(page.getByText(/Some sources could not be read fully/)).toBeVisible();
    await page.getByRole('button', { name: `Review ${item.effective.name}`, exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^Dish name/ })).toHaveValue(
      item.effective.name!,
    );
    await page.getByRole('textbox', { name: /^Dish name/ }).fill('Owner corrected synthetic dish');
    await completeRequiredDish(page);
    await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
    await expect.poll(() => state.correctionIds.length).toBe(1);
    expect(item.effective.name).toBe('Owner corrected synthetic dish');
    await expect(page.locator('.review-table')).toContainText('Owner corrected synthetic dish');
    expect(state.apiCalls.some(({ path }) => /retry|approve|publications/.test(path))).toBe(false);
  });
}

// Part A: S11 stays verification-only; Review and publish prepares the menu (never publishes),
// says when preparation failed, and Prepare again retries it.
test('completing verification does not prepare or approve anything', async ({ context, page }) => {
  const state = await fixture(context);
  const id = crypto.randomUUID();
  state.drafts[venue.venueId] = [
    {
      id,
      draft_id: id,
      job_id: null,
      origin: 'manual',
      draft_version: 1,
      name: 'Fictional Lentil Soup',
      category: 'Soup',
      description: 'Slow cooked lentil soup with herbs.',
      price_amount: '9.50',
      price_currency: 'CAD',
      ingredients: ['lentils'],
      source_text: null,
      review_warnings: [],
      review_status: 'pending',
      verification_status: 'not_verified',
      manual_fields: {
        name: 'Fictional Lentil Soup',
        category: 'Soup',
        description: 'Slow cooked lentil soup with herbs.',
        priceAmount: '9.50',
        priceCurrency: 'CAD',
        servingSize: '1 bowl',
        servingCount: 1,
        ingredients: { status: 'confirmed', items: ['lentils'] },
        allergens: { status: 'confirmed', items: [] },
        photoId: crypto.randomUUID(),
      },
    },
  ];
  await signIn(page, undefined, false);
  await page.getByRole('button', { name: 'Edit: Add your menu', exact: true }).click();
  await page.getByRole('button', { name: 'Complete verification', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Menu verified' })).toBeVisible();
  expect(
    state.apiCalls.filter((call) =>
      /prepare|\/drafts\/[^/]+\/approve$|approvals|publications/.test(call.path),
    ),
  ).toEqual([]);
});

test('Review and publish prepares the menu, shows a failure and retries with Prepare again', async ({
  context,
  page,
}) => {
  await fixture(context);
  const state = await preparedPublication(context);
  state.prepareFailure = 'unavailable';
  await signIn(page);
  await page.getByRole('button', { name: 'Review and publish' }).click();
  await expect(page.getByRole('alert')).toContainText('Menu not prepared yet');
  await expect(page.getByRole('alert')).toContainText('prepare again to retry');
  // An earlier prepared menu stays available while preparation is retried.
  await expect(
    page.getByRole('button', { name: 'Preview prepared menu 1', exact: true }),
  ).toBeVisible();
  await expect.poll(() => state.prepares).toBe(1);

  state.prepareFailure = 'menu_not_verified';
  await page.getByRole('button', { name: 'Prepare again' }).click();
  await expect(page.getByRole('alert')).toContainText('need verifying again');
  await expect.poll(() => state.prepares).toBe(2);

  state.prepareFailure = false;
  await page.getByRole('button', { name: 'Prepare again' }).click();
  await expect(page.getByText('Menu not prepared yet')).toHaveCount(0);
  await expect.poll(() => state.prepares).toBe(3);
  // Preparing approved and published nothing: S13 still needs the explicit Publish.
  expect(state.approvals).toEqual([]);
  expect(state.publishes).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Preview your menu', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish Menu', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Preview prepared menu/ })).toHaveCount(0);
  expect(state.publishes).toEqual([]);
});

test('retries failed 2.5D generation for an unchanged saved photo without duplicate requests', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const id = crypto.randomUUID();
  const photoId = crypto.randomUUID();
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    'base64',
  );
  state.photos.set(photoId, image);
  state.drafts[venue.venueId] = [
    {
      id,
      draft_id: id,
      job_id: null,
      origin: 'manual',
      draft_version: 2,
      name: 'Fictional Lentil Soup',
      category: 'Soup',
      description: 'Slow cooked lentil soup with herbs.',
      price_amount: '9.50',
      price_currency: 'CAD',
      ingredients: ['lentils'],
      source_text: null,
      review_warnings: [],
      review_status: 'pending',
      verification_status: 'not_verified',
      manual_fields: {
        name: 'Fictional Lentil Soup',
        category: 'Soup',
        description: 'Slow cooked lentil soup with herbs.',
        priceAmount: '9.50',
        priceCurrency: 'CAD',
        servingSize: '1 bowl',
        servingCount: 1,
        ingredients: { status: 'confirmed', items: ['lentils'] },
        allergens: { status: 'confirmed', items: [] },
        photoId,
      },
    },
  ];
  let generations = 0;
  let reads = 0;
  let approved = false;
  let finishFirstGeneration: (() => void) | undefined;
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  await context.route(
    `${api}/venues/${venue.venueId}/drafts/${id}/photos/${photoId}/portion**`,
    async (route) => {
      const method = route.request().method();
      const path = new URL(route.request().url()).pathname;
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (path.endsWith('/image'))
        return route.fulfill({ body: image, contentType: 'image/webp', headers });
      if (path.endsWith('/approve')) {
        approved = true;
        return route.fulfill({ json: { approved }, headers });
      }
      if (method === 'GET') {
        reads++;
        if (generations === 0)
          return route.fulfill({ status: 404, json: { error: 'not_found' }, headers });
      } else {
        generations++;
        if (generations === 1)
          await new Promise<void>((resolve) => {
            finishFirstGeneration = resolve;
          });
      }
      return route.fulfill({
        json: {
          portionReview: {
            status: generations === 1 ? 'failed' : 'needs_review',
            dish_id: id,
            draft_revision_id: photoId,
            approved,
          },
        },
        headers,
      });
    },
  );
  await signIn(page);
  const edit = page.getByRole('button', { name: 'Edit Fictional Lentil Soup', exact: true });
  await edit.click();
  const rights = page.getByRole('checkbox', { name: 'I have the right to use this photo.' });
  const generateBtn = page.getByRole('button', {
    name: 'Save photo and generate 2.5D',
    exact: true,
  });
  await expect.poll(() => reads + generations).toBe(1);
  await expect(rights).not.toBeChecked();
  await expect(generateBtn).toBeDisabled();
  expect(generations).toBe(0);
  expect(reads).toBe(1);
  await rights.check();
  await expect(generateBtn).toBeEnabled();
  expect(generations).toBe(0);
  await generateBtn.click();
  await expect.poll(() => Boolean(finishFirstGeneration)).toBe(true);
  await expect(page.getByLabel('Dish photo', { exact: true })).toBeEnabled();
  await expect(generateBtn).toBeDisabled();
  expect(generations).toBe(1);
  finishFirstGeneration!();
  await expect(
    page.getByText(
      '2.5D processing failed. Please try another photo. The original photo is retained.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '2.5D preview processing' })).toBeVisible();
  expect(generations).toBe(1);
  await generateBtn.click();
  await expect(
    page.getByRole('img', { name: 'Review-only 2.5D preview of Fictional Lentil Soup' }),
  ).toBeVisible();
  const portionCard = page.getByRole('region', { name: '2.5D preview', exact: true });
  const portionImage = portionCard.getByRole('img', {
    name: 'Review-only 2.5D preview of Fictional Lentil Soup',
  });
  await expect(portionImage).toBeVisible();
  const imageBounds = await portionImage.boundingBox();
  expect(imageBounds?.height).toBeGreaterThan(0);
  expect(imageBounds?.height).toBeLessThanOrEqual(120);
  expect(generations).toBe(2);
  await page.getByRole('button', { name: 'Approve 2.5D preview', exact: true }).click();
  await expect(portionCard.getByText('Approved for publication review')).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await edit.click();
  await expect(rights).not.toBeChecked();
  await expect(portionImage).toBeVisible();
  await expect(portionCard.getByText('Approved for publication review')).toBeVisible();
  expect(reads).toBe(2);
  expect(generations).toBe(2);
  await page.getByRole('textbox', { name: /^Dish name/ }).fill('Fictional Lentil Soup updated');
  await expect(
    page.getByRole('img', { name: 'Review-only 2.5D preview of Fictional Lentil Soup updated' }),
  ).toBeVisible();
  expect(generations).toBe(2);
});

test('gates Screen 9 photo upload and 2.5D generation on photo-rights confirmation (S7-VIS-06)', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    'base64',
  );
  let generations = 0;
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  await context.route(
    `${api}/venues/${venue.venueId}/drafts/*/photos/*/portion**`,
    async (route) => {
      const method = route.request().method();
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const parts = new URL(route.request().url()).pathname.split('/');
      if (parts.at(-1) === 'image') {
        return route.fulfill({ body: image, contentType: 'image/webp', headers });
      }
      if (method === 'GET')
        return route.fulfill({ status: 404, json: { error: 'not_found' }, headers });
      const draftIdx = parts.indexOf('drafts');
      const draftId = draftIdx >= 0 ? parts[draftIdx + 1] : '';
      const photoId = draftIdx >= 0 ? parts[draftIdx + 3] : '';
      generations++;
      return route.fulfill({
        json: {
          portionReview: {
            status: 'needs_review',
            dish_id: draftId,
            draft_revision_id: photoId,
            approved: false,
          },
        },
        headers,
      });
    },
  );

  await signIn(page);
  await page.getByRole('button', { name: 'Add dish', exact: true }).click();
  await page.getByRole('textbox', { name: /^Dish name/ }).fill('Fictional Herb Omelette');
  await addCategory(page, 'Breakfast');
  await page.getByRole('textbox', { name: /^Price/ }).fill('11.50');
  await page.getByRole('spinbutton', { name: 'Serving size (people)', exact: true }).fill('1');
  await page.getByRole('textbox', { name: /^Ingredients/ }).fill('Eggs');
  await page.getByRole('button', { name: 'Add ingredient', exact: true }).click();
  await page
    .getByLabel('Dish photo', { exact: true })
    .setInputFiles({ name: 'omelette.png', mimeType: 'image/png', buffer: image });

  const rights = page.getByRole('checkbox', { name: 'I have the right to use this photo.' });
  await expect(rights).toBeVisible();
  await expect(rights).not.toBeChecked();
  const generateBtn = page.getByRole('button', {
    name: 'Save photo and generate 2.5D',
    exact: true,
  });
  await expect(generateBtn).toBeDisabled();
  await page
    .getByRole('checkbox', { name: /I reviewed the AI-drafted text and ingredients/ })
    .check();
  const continueButton = page.getByRole('button', { name: 'Continue to review', exact: true });
  await expect(continueButton).toBeDisabled();
  expect(state.photos.size).toBe(0);
  expect(state.apiCalls.some((call) => /\/drafts\/[^/]+\/photos$/.test(call.path))).toBe(false);
  expect(generations).toBe(0);

  await rights.check();
  await expect(generateBtn).toBeEnabled();
  expect(state.photos.size).toBe(0);
  expect(generations).toBe(0);
  await generateBtn.click();
  await expect(
    page.getByRole('img', { name: 'Review-only 2.5D preview of Fictional Herb Omelette' }),
  ).toBeVisible();
  expect(state.photos.size).toBe(1);
  expect(state.apiCalls.some((call) => /\/drafts\/[^/]+\/photos$/.test(call.path))).toBe(true);
  expect(generations).toBe(1);

  await page
    .getByLabel('Dish photo', { exact: true })
    .setInputFiles({ name: 'omelette-replacement.png', mimeType: 'image/png', buffer: image });
  await expect(rights).not.toBeChecked();
  await expect(generateBtn).toBeDisabled();
  await expect(continueButton).toBeDisabled();
  expect(state.photos.size).toBe(1);
  expect(generations).toBe(1);

  await rights.check();
  await continueButton.click();
  await expect(
    page.getByText('Draft saved. This has not approved or published your menu.'),
  ).toBeVisible();
  await expect(continueButton).toHaveCount(0);
  expect(state.photos.size).toBe(2);
  expect(generations).toBe(1);
});

test('Screen 9 people count stays separate from a saved 28 cm plate and clears confirmation on edits', async ({
  context,
  page,
}, testInfo) => {
  const state = await fixture(context, true);
  const draft = state.drafts[venue.venueId]![0]!;
  const fields = draft.manual_fields as OwnerDishFields;
  const photoId = fields.photoId!;
  fields.servingSize = '1';
  fields.servingCount = 1;
  const original = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 640;
      const drawing = canvas.getContext('2d')!;
      drawing.fillStyle = '#eee9de';
      drawing.fillRect(0, 0, 640, 640);
      drawing.beginPath();
      drawing.arc(320, 320, 256, 0, Math.PI * 2);
      drawing.fillStyle = '#fffdf7';
      drawing.fill();
      drawing.strokeStyle = '#8c8170';
      drawing.lineWidth = 4;
      drawing.stroke();
      drawing.fillStyle = '#5b5143';
      drawing.font = '24px sans-serif';
      drawing.textAlign = 'center';
      drawing.fillText('SYNTHETIC PLATE', 320, 330);
      return canvas.toDataURL('image/png').split(',')[1]!;
    }),
    'base64',
  );
  state.photos.set(photoId, original);
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  await context.route(
    `${api}/venues/${venue.venueId}/drafts/${draft.id}/photos/${photoId}/portion**`,
    (route) =>
      route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers })
        : route.fulfill({
            json: {
              portionReview: {
                status: 'failed',
                dish_id: draft.id,
                draft_revision_id: photoId,
                approved: false,
              },
            },
            headers,
          }),
  );
  await signIn(page);
  await page.getByRole('button', { name: 'Edit Fictional Lentil Soup', exact: true }).click();
  const people = page.getByRole('spinbutton', { name: 'Serving size (people)', exact: true });
  const plate = page.getByRole('textbox', { name: 'Plate size (cm)', exact: true });
  const confirm = page.getByRole('checkbox', {
    name: 'I measured this plate and matched its boundary to this photo.',
    exact: true,
  });
  await expect(people).toHaveValue('1');
  await expect(page.getByRole('spinbutton', { name: 'People served', exact: true })).toHaveCount(0);
  await expect(plate).toHaveValue('');
  await expect(confirm).toBeDisabled();
  await plate.fill('28');
  await expect(confirm).toBeEnabled();
  await expect(confirm).not.toBeChecked();
  await confirm.check();
  await acknowledgeDish(page);
  await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
  await expect(
    page.getByText('Draft saved. This has not approved or published your menu.'),
  ).toBeVisible();
  expect(state.drafts[venue.venueId]![0]!.manual_fields).toMatchObject({
    servingSize: '1',
    servingCount: 1,
    portionCalibration: {
      shape: 'round',
      width_mm: 280,
      depth_mm: 280,
      source_sha256: createHash('sha256').update(original).digest('hex'),
      source_width_px: 640,
      source_height_px: 640,
      boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      confirmed: true,
    },
  });

  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Fictional Lentil Soup', exact: true }).click();
  await expect(people).toHaveValue('1');
  await expect(plate).toHaveValue('28');
  await expect(confirm).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('serving-size-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
  await page.screenshot({ path: testInfo.outputPath('serving-size-mobile.png'), fullPage: true });

  await test.step('Reject a fractional people count without saving the draft', async () => {
    const savedVersion = state.drafts[venue.venueId]![0]!.draft_version;
    await people.fill('1.5');
    await acknowledgeDish(page);
    await expect(
      page.getByRole('button', { name: 'Continue to review', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    // Continue is aria-disabled for invalid fields. Enter still exercises form validation;
    // locator.click() would wait for the button to become enabled until the test times out.
    await people.press('Enter');
    await expect(page.getByText('Enter a whole number of people from 1 to 100')).toBeVisible();
    expect(state.drafts[venue.venueId]![0]!.draft_version).toBe(savedVersion);
  });
  await people.fill('2');
  await expect(plate).toHaveValue('28');
  await expect(confirm).not.toBeChecked();
  await confirm.check();
  await acknowledgeDish(page);
  await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
  await expect(
    page.getByText('Draft saved. This has not approved or published your menu.'),
  ).toBeVisible();
  expect(state.drafts[venue.venueId]![0]!.manual_fields).toMatchObject({
    servingSize: '2',
    servingCount: 2,
    portionCalibration: { width_mm: 280, depth_mm: 280 },
  });
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Fictional Lentil Soup', exact: true }).click();
  await expect(people).toHaveValue('2');
  await expect(plate).toHaveValue('28');
  await expect(confirm).toBeChecked();
  await plate.fill('30 × 20 cm');
  await expect(confirm).not.toBeChecked();
  await expect(confirm).toBeEnabled();
  await confirm.check();
  const left = page.getByRole('spinbutton', { name: 'Plate boundary left (%)', exact: true });
  await left.fill('95');
  await expect(confirm).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  await expect(page.getByText(/Keep the whole boundary inside the photo/)).toBeVisible();
  await left.fill('10');
  await confirm.check();
  await page.getByLabel('Dish photo', { exact: true }).setInputFiles({
    name: 'replacement-synthetic.png',
    mimeType: 'image/png',
    buffer: original,
  });
  await expect(confirm).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  await expect(
    page.getByText('Save the new photo before confirming its measurements.'),
  ).toBeVisible();
});

test('a dish approved by an earlier preparation can still be edited (Back/Edit)', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const id = crypto.randomUUID();
  state.drafts[venue.venueId] = [
    {
      id,
      draft_id: id,
      job_id: null,
      origin: 'manual',
      draft_version: 2,
      name: 'Fictional Lentil Soup',
      category: 'Soup',
      description: 'Slow cooked lentil soup with herbs.',
      price_amount: '9.50',
      price_currency: 'CAD',
      ingredients: ['lentils'],
      source_text: null,
      review_warnings: [],
      review_status: 'accepted',
      verification_status: 'verified',
      manual_fields: {
        name: 'Fictional Lentil Soup',
        category: 'Soup',
        description: 'Slow cooked lentil soup with herbs.',
        priceAmount: '9.50',
        priceCurrency: 'CAD',
        servingSize: '1 bowl',
        servingCount: 1,
        ingredients: { status: 'confirmed', items: ['lentils'] },
        allergens: { status: 'confirmed', items: [] },
        photoId: null,
      },
    },
  ];
  await signIn(page);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const edit = page.getByRole('button', { name: 'Edit Fictional Lentil Soup', exact: true });
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(page.getByRole('heading', { name: 'Edit dish' })).toBeVisible();
});

test('Overview uses validated KPI cards and clears their values across restaurant and session changes', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
  state.venues = [venue, otherVenue];
  const missing = { value: null, status: 'MISSING' };
  const current = {
    menu_sessions: { value: 31, status: 'NORMAL' },
    dish_opens: { value: 42, status: 'NORMAL' },
    avg_interaction_time_seconds: { value: 0, status: 'VALID_ZERO' },
    portion_previews_shown: missing,
    verified_orders: missing,
  };
  const summary = {
    periods: {
      current: { start_time: '2026-10-19T07:00:00.000Z', end_time: '2026-10-20T07:00:00.000Z' },
      baseline: { start_time: '2026-10-18T07:00:00.000Z', end_time: '2026-10-19T07:00:00.000Z' },
    },
    current,
    baseline: {
      ...current,
      menu_sessions: { value: 20, status: 'NORMAL' },
      avg_interaction_time_seconds: { value: null, status: 'SUPPRESSED' },
    },
  };
  let venueMetric = 31;
  let delayVenue = false;
  let firstRequests = 0;
  const releaseLate = Promise.withResolvers<void>();
  const finishedLate = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  await context.route(`${api}/api/v1/venues/*/analytics/dishes*`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/')[4];
    const reportSummary = {
      ...summary,
      current: { ...current, menu_sessions: { value: venueMetric, status: 'NORMAL' } },
    };
    const late = id === venue.venueId && delayVenue;
    if (id === venue.venueId) firstRequests++;
    if (late) await releaseLate.promise;
    if (id === otherVenue.venueId) {
      secondStarted.resolve();
      await releaseSecond.promise;
    }
    try {
      await route.fulfill({
        json: OwnerDishReportSchema.parse({
          ...UNEEZA_REPORT,
          venue_id: id,
          ...(id === venue.venueId ? { summary: reportSummary } : {}),
        }),
        headers: { 'Access-Control-Allow-Origin': origin },
      });
    } finally {
      if (late) finishedLate.resolve();
    }
  });
  await signIn(page, undefined, false);
  await openAccount(page);
  await page.getByLabel('Restaurant', { exact: true }).selectOption(venue.venueId);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  const cards = page.locator('.owner-dashboard-content .kpis > .kpi');
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(0).locator('.v')).toHaveText('31');
  await expect(cards.nth(0).locator('.d')).toHaveText('Previous period: 20');
  await expect(cards.nth(1).locator('.v')).toHaveText('42');
  await expect(cards.nth(2).locator('.v')).toHaveText('0s');
  await expect(cards.nth(2).locator('.d')).toHaveText('Previous period: Not enough visits yet');
  await expect(cards.nth(3).locator('.v')).toHaveText('Unavailable');
  await expect(cards.nth(4).locator('.v')).toHaveText('Unavailable');
  await expect(page.getByRole('heading', { name: 'How your menu did this period' })).toBeVisible();
  const refresh = page.getByRole('button', { name: 'Refresh report', exact: true });
  await expect(refresh).toBeEnabled();
  venueMetric = 57;
  await refresh.click();
  await expect(cards.nth(0).locator('.v')).toHaveText('57');
  const requestsBeforeDelay = firstRequests;
  venueMetric = 78;
  delayVenue = true;
  try {
    await refresh.click();
    await expect.poll(() => firstRequests).toBe(requestsBeforeDelay + 1);
    await expect(refresh).toBeDisabled();
    await expect(cards.nth(0).locator('.v')).toHaveText('57');
    await openAccount(page);
    await page.getByLabel('Restaurant', { exact: true }).selectOption(otherVenue.venueId);
    await expect(cards).toHaveCount(0);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await secondStarted.promise;
    await expect(cards.nth(0).locator('.v')).toHaveText('Unavailable');
    releaseSecond.resolve();
    await expect(refresh).toBeEnabled();
    releaseLate.resolve();
    await finishedLate.promise;
    await expect(cards.nth(0).locator('.v')).toHaveText('Unavailable');
  } finally {
    releaseLate.resolve();
    releaseSecond.resolve();
  }
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(cards).toHaveCount(0);
});

test('Refresh report recovers an unavailable report and clears values when it becomes unavailable', async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
  state.reportStatus = 503;
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const refresh = page.getByRole('button', { name: 'Refresh report', exact: true });
  await expect(refresh).toBeEnabled();
  await expect(page.getByText('Reports aren’t available for this restaurant yet.')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  state.reportStatus = 200;
  await refresh.click();
  await expect(page.getByRole('table').first()).toBeVisible();

  await page.getByRole('button', { name: 'AI Insight Report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Menu activity report' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  state.reportStatus = 503;
  await refresh.click();
  await expect(page.getByText('Reports aren’t available for this restaurant yet.')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(refresh).toBeEnabled();
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
});

test('Refresh report rejects a wrong-venue response and recovers with the correct venue', async ({
  context,
  page,
}) => {
  await fixture(context, true);
  let reportVenueId = venue.venueId;
  let dishName = 'Initial report bowl';
  await context.route(`${api}/api/v1/venues/${venue.venueId}/analytics/dishes*`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            ...UNEEZA_REPORT,
            venue_id: reportVenueId,
            dishes: UNEEZA_REPORT.dishes.map((dish, index) =>
              index === 0 ? { ...dish, name: dishName } : dish,
            ),
          },
          headers: { 'Access-Control-Allow-Origin': origin },
        })
      : route.fallback(),
  );
  await signIn(page);
  await page.getByRole('button', { name: 'Dish performance', exact: true }).click();
  const table = page.getByRole('table').first();
  const refresh = page.getByRole('button', { name: 'Refresh report', exact: true });
  await expect(table).toContainText('Initial report bowl');

  reportVenueId = otherVenue.venueId;
  dishName = 'Other venue bowl';
  await refresh.click();
  await expect(page.getByText('We couldn’t verify this report, so it isn’t shown.')).toBeVisible();
  await expect(table).toHaveCount(0);
  await expect(page.getByText('Other venue bowl', { exact: true })).toHaveCount(0);
  await expect(refresh).toBeEnabled();

  reportVenueId = venue.venueId;
  dishName = 'Refreshed report bowl';
  await refresh.click();
  await expect(table).toContainText('Refreshed report bowl');
  await expect(table).not.toContainText('Initial report bowl');
});

test('staging creation retries the same command, opens S05 and keeps the next actor isolated', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.venues = [];
  const created = {
    ...venue,
    venueId: '44444444-4444-4444-8444-444444444444',
    name: 'Synthetic self-service cafe',
  };
  const requests: Array<{
    commandId: string;
    name: string;
    actor: string | undefined;
    keys: string[];
  }> = [];
  await context.route(`${api}/staff/venues`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    requests.push({
      ...body,
      actor: claims(route.request().headers().authorization).sub,
      keys: Object.keys(body).sort(),
    });
    // Model a committed request whose response was lost; retry must reuse its command.
    state.venues = [created];
    return route.fulfill({
      status: requests.length === 1 ? 500 : 201,
      json: requests.length === 1 ? { error: 'unavailable' } : { venue: created },
      headers: { 'Access-Control-Allow-Origin': origin },
    });
  });
  await signIn(page, undefined, false);
  await page
    .getByRole('button', { name: 'Create test restaurant (Staging testing)', exact: true })
    .click();
  await page.getByLabel('Test restaurant name (Staging testing)').fill(`  ${created.name}  `);
  await page.getByRole('button', { name: 'Create test restaurant', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Retry with the same name');
  await page.getByRole('button', { name: 'Create test restaurant', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Restaurant name', exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({
    name: created.name,
    actor: ownerId,
    keys: ['commandId', 'name'],
  });
  expect(state.apiCalls.some((call) => call.path === `/venues/${created.venueId}/profile`)).toBe(
    true,
  );
  expect(state.apiCalls.some((call) => /publications|\/approvals$/.test(call.path))).toBe(false);
  await page.getByLabel('Owner account', { exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, 'other@example.test', false);
  await page.getByLabel('Owner account', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Restaurant', exact: true })).toHaveValue(
    otherVenue.venueId,
  );
  await expect(page.getByRole('option', { name: created.name, exact: true })).toHaveCount(0);
});

test('staging quota failure preserves the existing restaurant and unknown access offers no creation', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  let creates = 0;
  await context.route(`${api}/staff/venues`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    creates++;
    return route.fulfill({
      status: 429,
      json: { error: 'restaurant_limit_reached' },
      headers: { 'Access-Control-Allow-Origin': origin },
    });
  });
  await signIn(page, undefined, false);
  await page.getByLabel('Owner account', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Create test restaurant (Staging testing)', exact: true })
    .click();
  await page
    .getByLabel('Test restaurant name (Staging testing)')
    .fill('Another synthetic restaurant');
  await page.getByRole('button', { name: 'Create test restaurant', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('limit has been reached');
  await expect(page.getByRole('combobox', { name: 'Restaurant', exact: true })).toHaveValue(
    venue.venueId,
  );
  expect(creates).toBe(1);
  state.invalidActor = true;
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Restaurant workspace unavailable' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Create test restaurant/ })).toHaveCount(0);
});

test('a delayed creation response cannot select a restaurant after the actor signs out', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  state.venues = [];
  let started = false;
  let release = () => {};
  await context.route(`${api}/staff/venues`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise<void>((resolve) => {
      release = resolve;
      started = true;
    });
    await route
      .fulfill({ status: 201, json: { venue }, headers: { 'Access-Control-Allow-Origin': origin } })
      .catch(() => {});
  });
  await signIn(page, undefined, false);
  await page
    .getByRole('button', { name: 'Create test restaurant (Staging testing)', exact: true })
    .click();
  await page
    .getByLabel('Test restaurant name (Staging testing)')
    .fill('Delayed synthetic restaurant');
  await page.getByRole('button', { name: 'Create test restaurant', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, 'other@example.test', false);
  release();
  await page.getByLabel('Owner account', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Restaurant', exact: true })).toHaveValue(
    otherVenue.venueId,
  );
  await expect(page.getByRole('option', { name: venue.name, exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Test restaurant name (Staging testing)')).toHaveCount(0);
});

test('removes several dishes in a row without waiting for each refresh', async ({
  context,
  page,
}) => {
  const state = await fixture(context);
  const base = {
    job_id: null,
    origin: 'manual',
    draft_version: 1,
    category: 'Soup',
    description: 'Synthetic dish.',
    price_amount: '9.50',
    price_currency: 'CAD',
    ingredients: ['lentils'],
    source_text: null,
    review_warnings: [],
    review_status: 'pending',
    verification_status: 'not_verified',
  };
  state.drafts[venue.venueId] = ['Fictional One', 'Fictional Two', 'Fictional Three'].map(
    (name) => {
      const id = crypto.randomUUID();
      return {
        ...base,
        id,
        draft_id: id,
        name,
        manual_fields: {
          name,
          category: 'Soup',
          description: 'Synthetic dish.',
          priceAmount: '9.50',
          priceCurrency: 'CAD',
          servingSize: '1 bowl',
          ingredients: { status: 'confirmed', items: ['lentils'] },
          allergens: { status: 'confirmed', items: [] },
        },
      };
    },
  ) as never;
  await signIn(page, undefined, false);
  await page.getByRole('button', { name: 'Edit: Add your menu', exact: true }).click();
  await expect(page.locator('.review-table')).toBeVisible();
  // Hold every refresh: before, each remove waited for it and the next click was ignored.
  state.delayJobs = true;
  for (const name of ['Fictional One', 'Fictional Two']) {
    await page.getByRole('button', { name: `Remove ${name}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toHaveCount(0);
  }
  await expect
    .poll(() => state.drafts[venue.venueId]!.filter((draft) => draft.removed_at).length)
    .toBe(2);
  await expect(
    page.getByRole('button', { name: 'Remove Fictional Three', exact: true }),
  ).toBeVisible();
  state.delayJobs = false;
  state.releaseJobs();
});
