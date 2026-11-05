// PostHog SDK adapter for the P0 tracking boundary agreed by Sai and Vivien (Nov 3) and settled with
// Nifemi (Nov 4): one track() call per UI action reaches PostHog through capturePostHog() (internal
// pilot funnels) and, separately, the canonical POST /observations path (owner reports).
// - Explicit events only: autocapture, pageviews, replay, surveys, flags, heatmaps, web vitals,
//   exceptions and external script loading are all off.
// - Approved properties only: POSTHOG_PROPERTIES below, after the payload passes the shared
//   observation.v2 payload schema. Never the canonical envelope (session_id, producer_id,
//   local_sequence), the menu token, URLs or referrers.
// - Identity: a separate random visit ID held in memory, never the canonical session_id. event_id
//   is the only reconciliation key; it becomes the PostHog event uuid.
// - Same gate as canonical: consent first, browser privacy signals respected, nothing in fixture
//   mode. The SDK is downloaded only after consent; withdrawing consent drops queued events.
// - Deduplication: the SDK and server do not guarantee dedup of resent events, so each event_id is
//   captured at most once per page. Canonical retries must never call this adapter again.
// - A PostHog failure never throws into the caller, so it cannot block canonical delivery or
//   browsing.
import { ObservationV2Schema } from '@peekaplate/contracts';
import type {
  PostHog,
  PostHogConfig,
  CaptureResult as PostHogEvent,
} from 'posthog-js/dist/module.slim.no-external';
import type { AnalyticsEnvironment, Surface } from './index';

// Same list as frontend/diner/src/tracking/event-names.ts (S3-TRK-01.1).
export const P0_EVENT_NAMES = [
  'menu_viewed',
  'dish_viewed',
  'dish_detail_opened',
  'dish_activity_checkpoint',
  'dish_compared',
  'dish_saved',
  'dish_unsaved',
  'shortlist_viewed',
] as const;
export type P0EventName = (typeof P0_EVENT_NAMES)[number];

const dish = ['dish_id', 'dish_revision_id'] as const;
// The only payload fields that may reach PostHog, per event. A new contract field stays local
// until it is added here in a reviewed change.
export const POSTHOG_PROPERTIES: Readonly<Record<P0EventName, readonly string[]>> = {
  menu_viewed: ['entry_source'],
  dish_viewed: [...dish, 'exposure_id', 'surface', 'position', 'exposure_basis', 'category_filter'],
  dish_detail_opened: [
    ...dish,
    'opening_id',
    'source',
    'from_exposure_id',
    'nav_relation',
    'save_available',
  ],
  dish_activity_checkpoint: [...dish, 'opening_id', 'active_ms', 'final'],
  dish_compared: [
    ...dish,
    'other_dish_id',
    'other_dish_revision_id',
    'comparison_id',
    'compare_action',
    'save_available',
  ],
  dish_saved: [...dish, 'save_origin', 'save_surface', 'shortlist_size'],
  dish_unsaved: [...dish, 'unsave_surface', 'shortlist_size'],
  shortlist_viewed: ['shortlist_size'],
};

const payloadSchemas = new Map(
  ObservationV2Schema.options.map((option) => [option.shape.type.value, option.shape.payload]),
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PostHogSdk = Pick<
  PostHog,
  'init' | 'capture' | 'opt_in_capturing' | 'opt_out_capturing' | 'reset'
>;

type Runtime = {
  origin: string;
  privacySignal: () => boolean;
  // False in fixture mode: fixture menus never send analytics.
  isLive: () => boolean;
  // Injected so tests use a fake; the browser default lazy-loads the slim, no-external build.
  loadSdk?: () => Promise<PostHogSdk>;
};

const loadPostHog = async (): Promise<PostHogSdk> =>
  (await import('posthog-js/dist/module.slim.no-external')).default;

// Events captured after consent while the SDK is still downloading; bounded so a slow or blocked
// download cannot grow memory without limit.
const MAX_PENDING = 50;
const MAX_SEEN = 2000;

// PostHog's own properties that may leave the browser. Everything else the SDK adds by default
// (page and entry URLs, referrers, user agent, screen, timezone, SDK debug data) is removed in
// before_send, so new SDK defaults cannot start leaking without a reviewed change here.
const KEPT_SDK_PROPERTIES = new Set([
  'token',
  'distinct_id',
  '$lib',
  '$lib_version',
  '$insert_id',
  '$time',
  '$process_person_profile',
  '$geoip_disable',
]);

type Pending = { type: P0EventName; properties: Record<string, unknown>; eventId: string };

// Approved PostHog properties for one event, or null when the payload fails the shared contract.
export function toPostHogProperties(
  type: P0EventName,
  payload: Readonly<Record<string, unknown>>,
  eventId: string,
): Record<string, unknown> | null {
  const allowed = POSTHOG_PROPERTIES[type];
  if (!allowed || !UUID.test(eventId)) return null;
  const parsed = payloadSchemas.get(type)?.safeParse(payload);
  if (!parsed?.success) return null;
  const data = parsed.data as Record<string, unknown>;
  const properties: Record<string, unknown> = { event_id: eventId.toLowerCase() };
  for (const name of allowed) if (data[name] !== undefined) properties[name] = data[name];
  return properties;
}

export function createPostHogAdapter(
  env: AnalyticsEnvironment,
  surface: Surface,
  runtime: Runtime,
) {
  const environment = env.VITE_POSTHOG_ENVIRONMENT;
  const host = env.VITE_POSTHOG_HOST;
  const key = env.VITE_POSTHOG_KEY;
  const configured =
    env.VITE_POSTHOG_ENABLED === 'true' &&
    (environment === 'staging' || environment === 'production') &&
    env.MODE === environment &&
    (host === 'https://us.i.posthog.com' || host === 'https://eu.i.posthog.com') &&
    typeof key === 'string' &&
    /^phc_[A-Za-z0-9_-]+$/.test(key) &&
    env.VITE_POSTHOG_ALLOWED_ORIGIN === runtime.origin;
  const load = runtime.loadSdk ?? loadPostHog;

  let consent = false;
  let sdk: PostHogSdk | null = null;
  let loading: Promise<void> | null = null;
  // Visit-scoped PostHog identity: random, memory only, replaced after consent withdrawal.
  let visitId = crypto.randomUUID();
  let pending: Pending[] = [];
  const seen = new Set<string>();

  function allowed() {
    try {
      return configured && consent && runtime.isLive() && !runtime.privacySignal();
    } catch {
      return false;
    }
  }

  function config(): Partial<PostHogConfig> {
    return {
      api_host: String(host),
      persistence: 'memory',
      person_profiles: 'never',
      bootstrap: { distinctID: visitId },
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      advanced_disable_flags: true,
      capture_performance: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      rageclick: false,
      capture_exceptions: false,
      disable_external_dependency_loading: true,
      save_referrer: false,
      save_campaign_params: false,
      mask_all_text: true,
      mask_all_element_attributes: true,
      // Final guard: only our mapped properties plus the SDK's required fields are sent.
      before_send: (event: PostHogEvent | null) => {
        if (!event) return null;
        if (!allowed()) return null;
        for (const name of Object.keys(event.properties)) {
          if (name.startsWith('$') && !KEPT_SDK_PROPERTIES.has(name)) delete event.properties[name];
        }
        delete event.$set;
        delete event.$set_once;
        event.properties.distinct_id = visitId;
        event.properties.$geoip_disable = true;
        event.properties.environment = environment;
        event.properties.surface = surface;
        return event;
      },
    };
  }

  function send(event: Pending) {
    if (!sdk || !allowed()) return;
    try {
      // The SDK's documented cross-source idempotency key: PostHog event uuid = event_id.
      sdk.capture(event.type, event.properties, { uuid: event.eventId });
    } catch {
      // PostHog must never block canonical delivery or browsing.
    }
  }

  function start() {
    if (sdk || loading) return;
    loading = load()
      .then((client) => {
        if (!allowed()) return;
        client.init(String(key), config());
        client.opt_in_capturing({ captureEventName: false });
        sdk = client;
        const queued = pending;
        pending = [];
        for (const event of queued) send(event);
      })
      .catch(() => {
        pending = [];
      })
      .finally(() => {
        loading = null;
      });
  }

  function setConsent(value: boolean) {
    consent = value;
    if (value) {
      try {
        sdk?.opt_in_capturing({ captureEventName: false });
      } catch {
        // Capture simply stays off if the SDK misbehaves.
      }
      return;
    }
    pending = [];
    visitId = crypto.randomUUID();
    try {
      sdk?.opt_out_capturing();
      sdk?.reset();
    } catch {
      // Withdrawal must still succeed locally even if the SDK misbehaves.
    }
    // before_send stamps the new visit ID, so a later opt-in starts a new PostHog visit.
  }

  // Called once per UI action by the shared track() dispatch (connectPostHog in the diner).
  function capturePostHog(
    type: P0EventName,
    payload: Readonly<Record<string, unknown>>,
    ids: { eventId: string },
  ): void {
    try {
      if (!allowed()) return;
      const properties = toPostHogProperties(type, payload, ids.eventId);
      if (!properties) return;
      const eventId = properties.event_id as string;
      if (seen.has(eventId)) return;
      if (seen.size >= MAX_SEEN) seen.clear();
      seen.add(eventId);
      const event = { type, properties, eventId };
      if (sdk) return send(event);
      if (pending.length >= MAX_PENDING) return;
      pending.push(event);
      start();
    } catch {
      // Never throw into track().
    }
  }

  return { configured, allowed, setConsent, capturePostHog };
}

export type PostHogAdapter = ReturnType<typeof createPostHogAdapter>;
export type CapturePostHog = PostHogAdapter['capturePostHog'];
