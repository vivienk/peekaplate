// PostHog SDK adapter for the P0 tracking boundary agreed by Sai and Vivien (Nov 3): one track()
// call per UI action reaches PostHog through its SDK (internal pilot funnels) and, separately,
// the canonical POST /observations path (owner reports). This adapter is only the PostHog side.
// - Explicit events only: autocapture, pageviews, replay, surveys, flags, heatmaps, web vitals,
//   exceptions and external script loading are all off.
// - Approved properties only: the event's own payload fields plus publication_revision_id. Never
//   the canonical envelope (producer_id, local_sequence), the menu token, URLs or referrers.
// - Consent first: the SDK is downloaded only after consent, nothing captured before consent is
//   replayed, and withdrawing consent or a browser privacy signal stops capture and drops queued
//   events.
// - Deduplication: PostHog's event uuid is the canonical event_id, and each event_id is captured
//   at most once per page. Canonical retries must never call this adapter again.
// - A PostHog failure never throws into the caller, so it cannot block canonical delivery or
//   browsing.
import { type ObservationV2, ObservationV2Schema } from '@peekaplate/contracts';
import type {
  PostHog,
  PostHogConfig,
  CaptureResult as PostHogEvent,
} from 'posthog-js/dist/module.slim.no-external';
import type { AnalyticsEnvironment, Surface } from './index';

export type PostHogCaptureResult =
  | 'disabled'
  | 'invalid'
  | 'duplicate'
  | 'queued'
  | 'sent'
  | 'failed';

export type PostHogSdk = Pick<
  PostHog,
  'init' | 'capture' | 'opt_in_capturing' | 'opt_out_capturing' | 'reset'
>;

type Runtime = {
  origin: string;
  privacySignal: () => boolean;
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

// PostHog event properties for one canonical observation. Session-scoped identity: the anonymous
// session_id is the PostHog distinct id, so funnels are per visit and never per person.
export function toPostHogProperties(event: ObservationV2): Record<string, unknown> {
  return {
    ...event.payload,
    publication_revision_id: event.publication_revision_id,
    event_id: event.event_id,
    schema_version: event.schema_version,
  };
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
  let distinctId: string | null = null;
  let pending: ObservationV2[] = [];
  const seen = new Set<string>();

  function allowed() {
    try {
      return configured && consent && !runtime.privacySignal();
    } catch {
      return false;
    }
  }

  function config(sessionId: string): Partial<PostHogConfig> {
    return {
      api_host: String(host),
      persistence: 'memory',
      person_profiles: 'never',
      bootstrap: { distinctID: sessionId },
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
      // Final guard: the PostHog event uuid is the canonical event_id (server-side dedup), and
      // only our mapped properties plus the SDK's required fields are sent.
      before_send: (event: PostHogEvent | null) => {
        if (!event) return null;
        if (!allowed()) return null;
        for (const name of Object.keys(event.properties)) {
          if (name.startsWith('$') && !KEPT_SDK_PROPERTIES.has(name)) delete event.properties[name];
        }
        delete event.$set;
        delete event.$set_once;
        const eventId = event.properties.event_id;
        if (typeof eventId === 'string') event.uuid = eventId;
        if (distinctId) event.properties.distinct_id = distinctId;
        event.properties.$geoip_disable = true;
        event.properties.environment = environment;
        event.properties.surface = surface;
        return event;
      },
    };
  }

  function send(event: ObservationV2) {
    if (!sdk || !allowed()) return 'disabled' as const;
    try {
      sdk.capture(event.type, toPostHogProperties(event), {
        timestamp: new Date(event.occurred_at),
      });
      return 'sent' as const;
    } catch {
      return 'failed' as const;
    }
  }

  function start(sessionId: string) {
    if (sdk || loading) return;
    loading = load()
      .then((client) => {
        if (!allowed()) return;
        client.init(String(key), config(sessionId));
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
    if (value) return;
    pending = [];
    try {
      sdk?.opt_out_capturing();
      sdk?.reset();
    } catch {
      // Withdrawal must still succeed locally even if the SDK misbehaves.
    }
  }

  // Called by the shared track() dispatch with a validated canonical event, once per UI action.
  function capture(input: unknown): PostHogCaptureResult {
    try {
      if (!allowed()) return 'disabled';
      const parsed = ObservationV2Schema.safeParse(input);
      if (!parsed.success) return 'invalid';
      const event = parsed.data;
      if (seen.has(event.event_id)) return 'duplicate';
      if (seen.size >= MAX_SEEN) seen.clear();
      seen.add(event.event_id);
      // A new visit gets a new session_id; before_send stamps it as the PostHog distinct id.
      distinctId = event.session_id;
      if (sdk) return send(event);
      if (pending.length >= MAX_PENDING) return 'failed';
      pending.push(event);
      start(event.session_id);
      return 'queued';
    } catch {
      return 'failed';
    }
  }

  return { configured, allowed, setConsent, capture };
}

export type PostHogAdapter = ReturnType<typeof createPostHogAdapter>;
