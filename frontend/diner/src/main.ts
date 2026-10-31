import { mountAnalyticsConsent } from '@peekaplate/analytics/consent';
import './style.css';
import { mountMenuScreen } from './menu/menuScreen';

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  mountMenuScreen(app);
  const consentHost = document.createElement('div');
  consentHost.id = 'consent';
  document.body.append(consentHost);
  mountAnalyticsConsent(consentHost, import.meta.env, 'diner');
}
