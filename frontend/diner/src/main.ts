import { mountAnalyticsConsent } from '@peekaplate/analytics/consent';
import {
  connectPostHogFromEnv,
  isTrackingAllowed,
  onTrackingAllowedChange,
  setTrackingAllowed,
} from './tracking';
import './style.css';
import { shouldOpenDining } from './dining/entry';
import { mountMenuScreen } from './menu/menuScreen';

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  if (
    shouldOpenDining(
      location.pathname,
      location.search,
      navigator.userAgent,
      import.meta.env.DEV ||
        import.meta.env.VITE_PORTION_DEMO ||
        import.meta.env.VITE_DINING_ENABLED === 'true',
    )
  ) {
    void import('./dining/screen')
      .then(({ mountDining }) => mountDining(app))
      .catch(() => mountMenuScreen(app));
  } else mountMenuScreen(app);
  const consentHost = document.createElement('div');
  consentHost.id = 'consent';
  document.body.append(consentHost);
  mountAnalyticsConsent(consentHost, import.meta.env, 'diner', {
    allowed: isTrackingAllowed,
    setConsent: setTrackingAllowed,
    subscribe: onTrackingAllowedChange,
  });
}

// PostHog for P0 tracking (S3-TRK-01): idle unless configured, live and consented.
connectPostHogFromEnv(import.meta.env);
