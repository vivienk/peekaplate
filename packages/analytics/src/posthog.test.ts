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

// The real SDK's browser behaviour (retries, storage) is covered in tests/e2e/posthog-adapter.spec.ts.
function fakeSdk() {
  const captured: { name: string; props: Record<string, unknown>; options: unknown }[] = [];
  const instances: { name: string; config: Config; __loaded: boolean }[] = [];
  const sdk = {
    __loaded: false,
    init: vi.fn((_key: string, config: Config, name: string) => {
      const instance = {
        name,
        config,
        __loaded: true,
        capture: (event: string, props: Record<string, unknown>, options: unknown) => {
          if (instance.__loaded) captured.push({ name: event, props, options });
          return undefined;
        },
      };
      instances.push(instance);
      return instance;
    }),
    capture: vi.fn(),
  };
  const last = () => {
    const instance = instances.at(-1);
    if (!instance) throw new Error('SDK was not initialised');
    return instance;
  };
  return {
    sdk: sdk as unknown as PostHogSdk & typeof sdk,
    captured,
    instances,
    config: () => last().config,
  };
}

function setup(
  overrides: { privacy?: boolean; live?: boolean; env?: Record<string, unknown> } = {},
) {
  const fake = fakeSdk();
  const loadSdk = vi.fn(async () => fake.sdk);
  const adapter = createPostHogAdapter(
    { ...env, ...overrides.env },
    {
      origin,
      privacySignal: () => overrides.privacy ?? false,
      isLive: () => overrides.live ?? true,
      loadSdk,
    },
  );
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
    expect(sent?.options).toEqual({ uuid: uuid(1), send_instantly: true });
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
    expect(fake.instances[0]?.name).toBe(`peekaplate_${visit}`);
  });

  it("keeps the event's own approved surface after before_send", async () => {
    const { adapter, fake, flush } = setup();
    adapter.setConsent(true);
    const viewed = {
      dish_id: uuid(400),
      dish_revision_id: uuid(401),
      exposure_id: uuid(402),
      surface: 'menu_list',
      position: 1,
      exposure_basis: 'viewport_50pct_1s',
    };
    adapter.capturePostHog('dish_viewed', viewed, { eventId: uuid(1) });
    await flush();
    const [sent] = fake.captured;
    const out = fake.config().before_send({
      uuid: uuid(1),
      event: 'dish_viewed',
      properties: { ...sent?.props },
    } as PostHogEvent);
    expect(out?.properties).toMatchObject({ ...viewed, environment: 'staging' });
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

  it('drops queued events, retires the SDK instance and starts a new visit when consent is withdrawn', async () => {
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
    const first = fake.instances[0];
    const firstVisit = first?.config.before_send(sdkEvent({}))?.properties.distinct_id;
    adapter.setConsent(false);
    expect(first?.__loaded).toBe(false);
    expect(first?.config.before_send(sdkEvent({}))).toBeNull();

    adapter.setConsent(true);
    // The retired instance stays retired even after a new opt-in.
    expect(first?.config.before_send(sdkEvent({}))).toBeNull();
    adapter.capturePostHog('menu_viewed', menuViewed, { eventId: uuid(3) });
    await flush();
    expect(fake.instances).toHaveLength(2);
    expect(fake.instances[1]?.name).not.toBe(first?.name);
    expect(fake.captured.map((c) => c.props.event_id)).toEqual([uuid(2), uuid(3)]);
    const secondVisit = fake.config().before_send(sdkEvent({}))?.properties.distinct_id;
    expect(secondVisit).not.toBe(firstVisit);
  });

  it('never throws when the SDK fails to load or to capture', async () => {
    const failingLoad = createPostHogAdapter(env, {
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
    fake.sdk.init.mockImplementation((_key, config, name) => ({
      name,
      config,
      __loaded: true,
      capture: () => {
        throw new Error('SDK error');
      },
    }));
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
