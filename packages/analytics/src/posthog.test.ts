import type { CaptureResult as PostHogEvent } from 'posthog-js/dist/module.slim.no-external';
import { describe, expect, it, vi } from 'vitest';
import {
  createPostHogAdapter,
  P0_EVENT_NAMES,
  POSTHOG_PROPERTIES,
  type PostHogSdk,
  toPostHogProperties,
} from './posthog';

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
const menuViewed = { entry_source: 'direct_link' };

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

function setup(
  overrides: { privacy?: boolean; live?: boolean; env?: Record<string, unknown> } = {},
) {
  const fake = fakeSdk();
  const loadSdk = vi.fn(async () => fake.sdk);
  const adapter = createPostHogAdapter({ ...env, ...overrides.env }, 'diner', {
    origin,
    privacySignal: () => overrides.privacy ?? false,
    isLive: () => overrides.live ?? true,
    loadSdk,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { adapter, fake, loadSdk, flush };
}

const sdkEvent = (properties: Record<string, unknown>) =>
  ({ uuid: uuid(1), event: 'menu_viewed', properties }) as PostHogEvent;

describe('PostHog SDK adapter', () => {
  it('does nothing, and never downloads the SDK, before consent', async () => {
    const { adapter, loadSdk, flush } = setup();
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
    await flush();
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('does not replay events from before consent', async () => {
    const { adapter, fake, flush } = setup();
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
    adapter.setConsent(true);
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(2) });
    await flush();
    expect(fake.captured.map((c) => c.props.event_id)).toEqual([uuid(2)]);
  });

  it('is off in fixture mode, when not configured, or when the browser asks for privacy', async () => {
    for (const s of [
      setup({ live: false }),
      setup({ env: { VITE_POSTHOG_ENABLED: 'false' } }),
      setup({ env: { VITE_POSTHOG_HOST: 'https://evil.example.test' } }),
      setup({ env: { MODE: 'development' } }),
      setup({ privacy: true }),
    ]) {
      s.adapter.setConsent(true);
      s.adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
      await s.flush();
      expect(s.loadSdk).not.toHaveBeenCalled();
      expect(s.adapter.allowed()).toBe(false);
    }
  });

  it('sends only event_id and approved payload fields, with event_id as the PostHog uuid', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
    await flush();
    const [sent] = fake.captured;
    expect(sent?.name).toBe('menu_viewed');
    expect(sent?.props).toEqual({ event_id: uuid(1), entry_source: 'direct_link' });
    expect(sent?.options).toEqual({ uuid: uuid(1) });
  });

  it('rejects payloads outside the shared contract, including envelope fields and the menu token', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    for (const payload of [
      { entry_source: 'tiktok' },
      { ...menuViewed, session_id: uuid(5) },
      { ...menuViewed, menu_token: 'secret' },
      { ...menuViewed, publication_revision_id: uuid(6) },
    ]) {
      adapter.capturePostHog('menu_viewed', payload, { eventId: uuid(1) });
    }
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: 'not-a-uuid' });
    await flush();
    expect(fake.captured).toHaveLength(0);
  });

  it('starts the SDK with every automatic collection feature off and a separate visit ID', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
    await flush();
    const config = fake.config();
    expect(config).toMatchObject({
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
    const visit = (config.bootstrap as { distinctID: string }).distinctID;
    expect(visit).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.sdk.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
  });

  it('strips SDK defaults and person data, keeping only required SDK fields', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
    await flush();
    const visit = (fake.config().bootstrap as { distinctID: string }).distinctID;
    const out = fake.config().before_send({
      ...sdkEvent({
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
      }),
      $set: { email: 'never@example.test' },
    });
    expect(out?.uuid).toBe(uuid(1));
    expect(out?.properties.distinct_id).toBe(visit);
    expect(out?.properties.$geoip_disable).toBe(true);
    for (const leak of [
      '$current_url',
      '$referrer',
      '$pathname',
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
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
    await flush();
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1).toUpperCase() });
    expect(fake.captured).toHaveLength(1);
  });

  it('stops, drops queued events and starts a new visit when consent is withdrawn', async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
    adapter.setConsent(false);
    await flush();
    expect(fake.captured).toHaveLength(0);
    expect(fake.sdk.init).not.toHaveBeenCalled();

    adapter.setConsent(true);
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(2) });
    await flush();
    const firstVisit = fake.config().before_send(sdkEvent({}))?.properties.distinct_id;
    adapter.setConsent(false);
    expect(fake.sdk.opt_out_capturing).toHaveBeenCalled();
    expect(fake.sdk.reset).toHaveBeenCalled();
    expect(fake.config().before_send(sdkEvent({}))).toBeNull();

    adapter.setConsent(true);
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(3) });
    expect(fake.captured.map((c) => c.props.event_id)).toEqual([uuid(2), uuid(3)]);
    const secondVisit = fake.config().before_send(sdkEvent({}))?.properties.distinct_id;
    expect(secondVisit).not.toBe(firstVisit);
  });

  it('never throws when the SDK fails to load or to capture', async () => {
    const failingLoad = createPostHogAdapter(env, 'diner', {
      origin,
      privacySignal: () => false,
      isLive: () => true,
      loadSdk: () => Promise.reject(new Error('blocked by an ad blocker')),
    });
    failingLoad.setConsent(true);
    expect(() =>
      failingLoad.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { adapter, fake, flush } = setup();
    fake.sdk.capture.mockImplementation(() => {
      throw new Error('SDK error');
    });
    adapter.setConsent(true);
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(1) });
    await flush();
    expect(() =>
      adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(2) }),
    ).not.toThrow();
  });

  it('has an allowlist for every P0 event and keeps only listed fields', () => {
    expect(Object.keys(POSTHOG_PROPERTIES).sort()).toEqual([...P0_EVENT_NAMES].sort());
    const saved = {
      dish_id: uuid(400),
      dish_revision_id: uuid(401),
      save_origin: 'undo',
      save_surface: 'dish_detail',
      shortlist_size: 2,
    };
    expect(toPostHogProperties('dish_saved', saved, uuid(1))).toEqual({
      event_id: uuid(1),
      ...saved,
    });
  });
});
