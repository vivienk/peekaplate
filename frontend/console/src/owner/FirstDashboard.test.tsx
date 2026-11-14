import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FirstDashboard } from './FirstDashboard';
import type { OwnerSetup } from './setup';

const noop = () => {};
// 11 pm local: later than midnight UTC in Toronto, so a UTC date would wrongly say Nov 12.
const today = new Date(2026, 10, 11, 23);
const render = (setup: OwnerSetup, showPublishSuccess = false) =>
  renderToStaticMarkup(
    <FirstDashboard
      setup={setup}
      onOpenStep={noop}
      onNavigate={noop}
      today={today}
      showPublishSuccess={showPublishSuccess}
      onClosePublishSuccess={noop}
    />,
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

const figmaState: OwnerSetup = {
  venueId: 'venue-1',
  restaurantName: 'Ember & Stone',
  detailsStatus: 'verified',
  menuAdded: false,
  published: false,
};
const published: OwnerSetup = { ...figmaState, menuAdded: true, published: true };

describe('FirstDashboard (S12 first dashboard arrival, S6-FE-14 onboarding)', () => {
  it('uses one restaurant name everywhere and shows progress from the setup facts', () => {
    const html = render(figmaState);
    const words = text(html);
    expect(words).toContain('Finish setting up Ember & Stone.');
    expect(words).toContain('1 of 3 steps complete');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-venue-id="venue-1"');
    expect(words).not.toContain('Maple Street Kitchen');
  });

  it('shows today in the top bar, never an invented report period or numbers', () => {
    const html = render(figmaState);
    const words = text(html);
    expect(words).toContain('We never show placeholder numbers.');
    expect(html).toContain('<time class="owner-chip" dateTime="2026-11-11">Nov 11, 2026</time>');
    expect(words).not.toMatch(/Oct|%|sessions/);
    const withPeriod = text(render({ ...published, reportPeriod: 'Nov 2–8, 2026' }));
    expect(withPeriod).toContain('Nov 2–8, 2026');
    expect(withPeriod).not.toContain('Nov 11, 2026');
  });

  it('lists Restaurant Setup last in the sidebar', () => {
    const labels = [
      ...render(figmaState).matchAll(/owner-nav__label">(?:<img[^>]*>)?([^<]+)</g),
    ].map((m) => m[1]);
    expect(labels).toEqual([
      'Overview',
      'AI Insight Report',
      'Dish performance',
      'Menu',
      'Actions',
      'Restaurant Setup',
    ]);
  });

  it('labels only finished steps and shows no publish button while publishing is locked', () => {
    const html = render(figmaState);
    // Success pills: step 1 and the verification card only; steps 2 and 3 have none.
    expect(html.match(/owner-status--success/g)).toHaveLength(2);
    expect(html).not.toContain('Review and publish"');
    expect(html).not.toMatch(/aria-label="[^"]*Review and publish"/);
    expect(text(html)).toContain('Opens after you add your menu.');
  });

  it('locks every sidebar page except Restaurant Setup before publication', () => {
    const html = render(figmaState);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(5);
    expect(text(html)).toContain('These pages open after you publish your menu.');
    const after = render(published);
    expect(after).not.toContain('aria-disabled');
    expect(text(after)).not.toContain('Restaurant Setup');
    expect(text(after)).not.toContain('These pages open after you publish your menu.');
  });

  it('shows not verified, or waiting, until the team has checked the details', () => {
    const missing = text(render({ ...figmaState, detailsStatus: 'missing' }));
    expect(missing).toContain('Not verified');
    expect(missing).toContain('0 of 3 steps complete');
    expect(missing).toContain('Add restaurant details');
    expect(missing).not.toContain('Review restaurant details');
    const submitted = text(render({ ...figmaState, detailsStatus: 'submitted' }));
    expect(submitted).toContain('Waiting for verification');
    expect(submitted).toContain("We've received your restaurant details and are checking them.");
  });

  it('keeps the AI panel off during onboarding: fixed text, composer disabled', () => {
    const html = render(figmaState);
    expect(html).toContain('data-ai-state="onboarding"');
    expect(text(html)).toContain('AI turns on after you publish');
    expect(html).toMatch(/id="owner-ai-input"[^>]*disabled/);
  });

  it('follows the Nov 11 design review: no idle spinner, no setup dot, shared badge column, AI variant', () => {
    const html = render(figmaState);
    // 02: the next-action buttons hold only their label while nothing is loading.
    const actions = html.slice(html.indexOf('owner-progress__actions'), html.indexOf('</section>'));
    expect(actions).not.toContain('<img');
    // 05B: no orange dot (or its hidden text) on the active Restaurant Setup item.
    expect(html).not.toContain('setup not finished');
    // 03: both status rows sit in one grid, so the descriptions share a start position.
    expect(html.match(/owner-verify__rows/g)).toHaveLength(1);
    // 04: onboarding uses the AI panel's Disabled variant; publication switches to Default.
    expect(html).toContain('data-variant="disabled"');
    expect(render(published)).toContain('data-variant="default"');
  });

  it('uses the Figma Status Label tones: verified success, waiting information, not published warning', () => {
    // A status pill with its tone, its leading icon and its text.
    const label = (tone: string, icon: string, words: string) =>
      new RegExp(`owner-status--${tone}" data-icon="${icon}"><img[^>]*>${words}<`);
    const verified = render(figmaState);
    expect(verified).toMatch(label('success', 'check', 'Verified'));
    expect(verified).toMatch(label('warning', 'lock', 'Not published'));
    const waiting = render({ ...figmaState, detailsStatus: 'submitted' });
    expect(waiting).toMatch(label('information', 'clock', 'Waiting for verification'));
    expect(waiting).toMatch(label('information', 'clock', 'Waiting'));
  });

  it('shows the same date chip in the AI panel as in the top bar (Figma AI context chips)', () => {
    const html = render(figmaState);
    const ai = html.slice(html.indexOf('owner-ai__head'));
    expect(ai).toContain(
      '<time class="owner-chip owner-chip--surface" dateTime="2026-11-11">Nov 11, 2026</time>',
    );
  });

  it('shows the success pop-up only after confirmed publication, about publishing only', () => {
    expect(render(figmaState, true)).not.toContain('owner-dialog');
    expect(render(published)).not.toContain('owner-dialog');
    const html = render(published, true);
    const dialog = html.slice(html.indexOf('<dialog'));
    expect(dialog).toContain('aria-labelledby="owner-dialog-title"');
    expect(text(dialog)).toContain('Your menu is published');
    expect(text(dialog)).toContain('Go to dashboard');
    expect(text(dialog)).not.toMatch(/verif/i);
    const page = text(render(published));
    expect(page).toContain('Ember & Stone is published. Your dashboard pages are now open.');
    expect(page).not.toContain('Finish setting up');
    expect(render(published)).toContain('data-ai-state="empty"');
  });
});
