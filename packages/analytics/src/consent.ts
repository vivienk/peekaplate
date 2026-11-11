import { type AnalyticsEnvironment, createAnalytics, type Surface } from './index';

type ConsentController = {
  allowed(): boolean;
  setConsent(allowed: boolean): void;
  subscribe(listener: (allowed: boolean) => void): () => void;
};

export function mountAnalyticsConsent(
  parent: HTMLElement,
  env: AnalyticsEnvironment,
  surface: Surface,
): { analytics: ReturnType<typeof createAnalytics>; dispose(): void };
export function mountAnalyticsConsent(
  parent: HTMLElement,
  env: AnalyticsEnvironment,
  surface: Surface,
  controller: ConsentController,
): { dispose(): void };
export function mountAnalyticsConsent(
  parent: HTMLElement,
  env: AnalyticsEnvironment,
  surface: Surface,
  controller?: ConsentController,
) {
  const analytics = controller
    ? undefined
    : createAnalytics(env, surface, {
        origin: location.origin,
        privacySignal: () =>
          navigator.doNotTrack === '1' ||
          (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl ===
            true,
        fetch: (...args) => fetch(...args),
        uuid: () => crypto.randomUUID(),
      });
  if (!controller && !analytics?.configured) return { analytics, dispose: () => {} };
  const allowed = () => (controller ? controller.allowed() : analytics!.allowed());
  const setConsent = (value: boolean) =>
    controller ? controller.setConsent(value) : analytics!.setConsent(value);
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Optional analytics');
  const description = document.createElement('p');
  description.textContent = controller
    ? 'Optional analytics records supported menu and dish interactions for restaurant reports and PostHog. No names, account details or page addresses are included. Our services and PostHog receive connection metadata. Your choice lasts until you leave or reload this page.'
    : 'Optional analytics sends basic screen and supported dish interactions to PostHog. No names, account details or page addresses are included. PostHog receives your connection IP. Your choice lasts until you leave or reload this page.';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Allow optional analytics';
  button.setAttribute('aria-pressed', 'false');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Optional analytics is off.';
  const update = () => {
    const active = allowed();
    button.setAttribute('aria-pressed', String(active));
    button.textContent = active ? 'Turn off optional analytics' : 'Allow optional analytics';
    status.textContent = active
      ? 'Optional analytics is on for this page.'
      : 'Optional analytics is off. Browser privacy preferences are respected.';
  };
  const stop = controller?.subscribe(update);
  update();
  button.addEventListener('click', () => {
    setConsent(!allowed());
    update();
    if (!controller && allowed()) void analytics!.captureShellView();
  });
  section.append(description, button, status);
  parent.append(section);
  return {
    analytics,
    dispose: () => {
      stop?.();
      setConsent(false);
      section.remove();
    },
  };
}
