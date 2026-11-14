import { mountAnalyticsConsent } from '@peekaplate/analytics/consent';
import {
  connectPostHogFromEnv,
  isTrackingAllowed,
  onTrackingAllowedChange,
  setTrackingAllowed,
} from './tracking';
// Self-hosted Latin Inter, the Figma typeface (the console loads the same package). Without it the
// "Inter" in the font stacks fell back to the system font.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import './style.css';
import { mountMenuScreen } from './menu/menuScreen';

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  mountMenuScreen(app);
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
