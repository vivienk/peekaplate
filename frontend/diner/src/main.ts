import { mountAnalyticsConsent } from '@peekaplate/analytics/consent';
import { connectPostHogFromEnv } from './tracking';
import './style.css';

const main = document.querySelector('main');
if (main) mountAnalyticsConsent(main, import.meta.env, 'diner');

// PostHog for P0 tracking (S3-TRK-01): idle unless configured, live and consented.
connectPostHogFromEnv(import.meta.env);
