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
  let updateDiner: (() => void) | undefined;
  let preferenceButton: HTMLButtonElement | undefined;
  const update = () => {
    const active = allowed();
    button.setAttribute('aria-pressed', String(active));
    button.textContent = active ? 'Turn off optional analytics' : 'Allow optional analytics';
    status.textContent = active
      ? 'Optional analytics is on for this page.'
      : 'Optional analytics is off. Browser privacy preferences are respected.';
    updateDiner?.();
  };
  const stop = controller?.subscribe(update);
  update();
  button.addEventListener('click', () => {
    const enabling = !allowed();
    setConsent(enabling);
    update();
    if (controller && !allowed() && enabling) {
      status.textContent = 'Your browser privacy preferences keep optional analytics off.';
    }
    if (!controller && allowed()) void analytics!.captureShellView();
  });
  section.append(description, button, status);
  if (controller && surface === 'diner') {
    const title = document.createElement('strong');
    title.textContent = 'Allow optional analytics?';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'What gets shared';
    details.append(summary, description);
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Not now';
    const expand = document.createElement('button');
    preferenceButton = expand;
    expand.type = 'button';
    expand.textContent = 'Analytics preferences';
    expand.hidden = true;
    const collapse = () => {
      section.hidden = true;
      expand.hidden = false;
      expand.focus();
    };
    dismiss.addEventListener('click', collapse);
    button.addEventListener('click', collapse);
    expand.addEventListener('click', () => {
      section.hidden = false;
      expand.hidden = true;
      button.focus();
    });
    const label = () => {
      button.textContent = allowed() ? 'Turn off optional analytics' : 'Yes';
      button.setAttribute(
        'aria-label',
        allowed() ? 'Turn off optional analytics' : 'Yes, allow optional analytics',
      );
      dismiss.textContent = allowed() ? 'Close' : 'Not now';
    };
    updateDiner = label;
    label();
    section.replaceChildren(title, details, button, dismiss, status);
    parent.append(expand);
  }
  parent.append(section);
  return {
    analytics,
    dispose: () => {
      stop?.();
      setConsent(false);
      section.remove();
      preferenceButton?.remove();
    },
  };
}
