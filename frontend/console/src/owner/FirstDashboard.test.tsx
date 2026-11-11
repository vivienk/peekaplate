import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FirstDashboard } from './FirstDashboard';
import type { OwnerSetup } from './setup';

const noop = () => {};
const render = (setup: OwnerSetup, sample = false, showPublishSuccess = false) =>
  renderToStaticMarkup(
    <FirstDashboard
      setup={setup}
      onOpenStep={noop}
      onNavigate={noop}
      sample={sample}
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

  it('never shows invented numbers, a report period or a sample label unless given', () => {
    const words = text(render(figmaState));
    expect(words).toContain('We never show placeholder numbers.');
    expect(words).not.toContain('Illustrative sample data');
    expect(words).not.toMatch(/Oct|%|sessions/);
    expect(text(render(figmaState, true))).toContain('Illustrative sample data');
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

  it('shows the success pop-up only after confirmed publication, about publishing only', () => {
    expect(render(figmaState, false, true)).not.toContain('owner-dialog');
    expect(render(published)).not.toContain('owner-dialog');
    const html = render(published, false, true);
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
