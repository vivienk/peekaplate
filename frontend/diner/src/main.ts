import { mountAnalyticsConsent } from '@peekaplate/analytics/consent';
import './style.css';
import { mountMenuScreen } from './menu/menuScreen';

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  mountMenuScreen(app);
  mountAnalyticsConsent(app, import.meta.env, 'diner');
}
