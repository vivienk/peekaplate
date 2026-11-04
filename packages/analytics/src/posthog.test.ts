import type { CaptureResult as PostHogEvent } from 'posthog-js/dist/module.slim.no-external';
import { describe, expect, it, vi } from 'vitest';
import { createPostHogAdapter, type PostHogSdk, toPostHogProperties } from './posthog';

const env = {
  MODE: 'staging',
  VITE_POSTHOG_ENABLED: 'true',
  VITE_POSTHOG_ENVIRONMENT: 'staging',
  VITE_POSTHOG_HOST: 'https://us.i.posthog.com',
  VITE_POSTHOG_KEY: 'phc_test_key',
  VITE_POSTHOG_ALLOWED_ORIGIN: 'https://diner.example.test',
};
const origin = 'https://diner.example.test';

const uuid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const menuViewed = (n = 1, session = uuid(100)) => ({
  schema_version: 'observation.v2',
  event_id: uuid(n),
  session_id: session,
  producer_id: uuid(200),
  local_sequence: n,
  occurred_at: '2026-11-03T12:00:00.000Z',
  publication_revision_id: uuid(300),
  type: 'menu_viewed',
  payload: { entry_source: 'direct_link' },
});

type Config = { before_send: (e: PostHogEvent | null) => PostHogEvent | null } & Record<
  string,
  unknown
>;

function fakeSdk() {
  const captured: { name: string; props: Record<string, unknown>; options: unknown }[] = [];
  let config: Config | undefined;
  const sdk = {
    init: vi.fn((_key: string, c: Config) => {
      config = c;
    }),
    capture: vi.fn((name: string, props: Record<string, unknown>, options: unknown) => {
      captured.push({ name, props, options });
      return undefined;
    }),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    reset: vi.fn(),
  };
  return {
    sdk: sdk as unknown as PostHogSdk & typeof sdk,
    captured,
    config: () => {
      if (!config) throw new Error('SDK was not initialised');
      return config;
    },
  };
}

function setup(overrides: { privacy?: boolean; env?: Record<string, unknown> } = {}) {
  const fake = fakeSdk();
  const loadSdk = vi.fn(async () => fake.sdk);
  const adapter = createPostHogAdapter({ ...env, ...overrides.env }, 'diner', {
    origin,
    privacySignal: () => overrides.privacy ?? false,
    loadSdk,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { adapter, fake, loadSdk, flush };
}

describe('PostHog SDK adapter', () => {
  it('does nothing, and never downloads the SDK, before consent', async () => {
    const { adapter, loadSdk, flush } = setup();
    expect(adapter.capture(menuViewed())).toBe('disabled');
    await flush();
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('does not replay events from before consent', async () => {
    const { adapter, fake, flush } = setup();
    adapter.capture(menuViewed(1));
    adapter.setConsent(true);
    expect(adapter.capture(menuViewed(2))).toBe('queued');
    await flush();
    expect(fake.captured.map((c) => c.props.event_id)).toEqual([uuid(2)]);
  });

  it('is off when not configured for staging/production or when the browser asks for privacy', () => {
    for (const setupResult of [
      setup({ env: { VITE_POSTHOG_ENABLED: 'false' } }),
      setup({ env: { VITE_POSTHOG_HOST: 'https://evil.example.test' } }),
      setup({ env: { MODE: 'development' } }),
      setup({ privacy: true }),
    ]) {
      setupResult.adapter.setConsent(true);
      expect(setupResult.adapter.capture(menuViewed())).toBe('disabled');
    }
  });

  it('sends approved properties only, never the canonical envelope', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    adapter.capture(menuViewed());
    await flush();
    const [sent] = fake.captured;
    expect(sent?.name).toBe('menu_viewed');
    expect(sent?.props).toEqual({
      entry_source: 'direct_link',
      publication_revision_id: uuid(300),
      event_id: uuid(1),
      schema_version: 'observation.v2',
    });
    expect(sent?.props).not.toHaveProperty('producer_id');
    expect(sent?.props).not.toHaveProperty('local_sequence');
    expect(sent?.props).not.toHaveProperty('session_id');
    expect(sent?.options).toEqual({ timestamp: new Date('2026-11-03T12:00:00.000Z') });
  });

  it('starts the SDK with every automatic collection feature off', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    adapter.capture(menuViewed());
    await flush();
    expect(fake.config()).toMatchObject({
      api_host: 'https://us.i.posthog.com',
      persistence: 'memory',
      person_profiles: 'never',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_flags: true,
      capture_exceptions: false,
      capture_performance: false,
      disable_external_dependency_loading: true,
      save_referrer: false,
      save_campaign_params: false,
    });
    expect(fake.sdk.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
  });

  it('uses event_id as the PostHog uuid, the visit as distinct id, and sends only approved fields', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    adapter.capture(menuViewed(1, uuid(100)));
    await flush();
    const out = fake.config().before_send({
      uuid: 'sdk-generated',
      event: 'menu_viewed',
      properties: {
        event_id: uuid(1),
        $current_url: 'https://diner.example.test/venues/x?src=qr',
        $referrer: 'https://search.example.test',
        $pathname: '/venues/x',
        $session_entry_url: 'https://diner.example.test/venues/x?utm_source=qr',
        $session_entry_referrer: 'https://search.example.test',
        $raw_user_agent: 'Mozilla/5.0',
        $screen_width: 1280,
        $timezone: 'America/Toronto',
        token: 'phc_test_key',
        $lib: 'web',
        $insert_id: 'abc',
        entry_source: 'direct_link',
      },
      $set: { email: 'never@example.test' },
    });
    expect(out?.uuid).toBe(uuid(1));
    expect(out?.properties.distinct_id).toBe(uuid(100));
    expect(out?.properties.$geoip_disable).toBe(true);
    expect(out?.properties).not.toHaveProperty('$current_url');
    expect(out?.properties).not.toHaveProperty('$referrer');
    expect(out?.properties).not.toHaveProperty('$pathname');
    for (const leak of [
      '$session_entry_url',
      '$session_entry_referrer',
      '$raw_user_agent',
      '$screen_width',
      '$timezone',
    ])
      expect(out?.properties).not.toHaveProperty(leak);
    expect(out?.properties).toMatchObject({
      token: 'phc_test_key',
      $lib: 'web',
      $insert_id: 'abc',
      entry_source: 'direct_link',
    });
    expect(out).not.toHaveProperty('$set');
  });

  it('captures each event_id at most once, so repeated calls never double count', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    adapter.capture(menuViewed(1));
    expect(adapter.capture(menuViewed(1))).toBe('duplicate');
    await flush();
    expect(adapter.capture(menuViewed(1))).toBe('duplicate');
    expect(fake.captured).toHaveLength(1);
  });

  it('rejects events that do not match the shared observation contract', () => {
    const { adapter } = setup();
    adapter.setConsent(true);
    expect(adapter.capture({ ...menuViewed(), payload: { entry_source: 'tiktok' } })).toBe(
      'invalid',
    );
    expect(adapter.capture({ ...menuViewed(), menu_token: 'secret' })).toBe('invalid');
  });

  it('stops and drops queued events when consent is withdrawn', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    adapter.capture(menuViewed(1));
    adapter.setConsent(false);
    await flush();
    expect(fake.captured).toHaveLength(0);
    expect(fake.sdk.init).not.toHaveBeenCalled();

    adapter.setConsent(true);
    adapter.capture(menuViewed(2));
    await flush();
    adapter.setConsent(false);
    expect(fake.sdk.opt_out_capturing).toHaveBeenCalled();
    expect(fake.sdk.reset).toHaveBeenCalled();
    expect(adapter.capture(menuViewed(3))).toBe('disabled');
    expect(
      fake.config().before_send({ uuid: 'x', event: 'menu_viewed', properties: {} }),
    ).toBeNull();
  });

  it('never throws when the SDK fails to load or to capture', async () => {
    const failingLoad = createPostHogAdapter(env, 'diner', {
      origin,
      privacySignal: () => false,
      loadSdk: () => Promise.reject(new Error('blocked by an ad blocker')),
    });
    failingLoad.setConsent(true);
    expect(failingLoad.capture(menuViewed(1))).toBe('queued');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { adapter, fake, flush } = setup();
    fake.sdk.capture.mockImplementation(() => {
      throw new Error('SDK error');
    });
    adapter.setConsent(true);
    adapter.capture(menuViewed(1));
    await flush();
    expect(adapter.capture(menuViewed(2))).toBe('failed');
  });

  it('maps every payload field through unchanged', () => {
    const event = {
      ...menuViewed(),
      type: 'dish_saved' as const,
      payload: {
        dish_id: uuid(400),
        dish_revision_id: uuid(401),
        save_origin: 'undo' as const,
        save_surface: 'dish_detail' as const,
        shortlist_size: 2,
      },
    };
    expect(toPostHogProperties(event as Parameters<typeof toPostHogProperties>[0])).toMatchObject(
      event.payload,
    );
  });
});
