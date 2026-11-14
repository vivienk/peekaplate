import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FirstDashboard } from './FirstDashboard';
import type { OwnerSetup } from './setup';

const noop = () => {};
const render = (setup: OwnerSetup, sample = false) =>
  renderToStaticMarkup(
    <FirstDashboard setup={setup} onOpenStep={noop} onNavigate={noop} sample={sample} />,
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

const figmaState: OwnerSetup = {
  restaurantName: 'Ember & Stone',
  detailsVerified: true,
  menuAdded: false,
  published: false,
};

describe('FirstDashboard (S12 first dashboard arrival)', () => {
  it('uses one restaurant name everywhere and shows progress from the setup facts', () => {
    const html = render(figmaState);
    const words = text(html);
    expect(words).toContain('Finish setting up Ember & Stone.');
    expect(words).toContain('1 of 3 steps complete');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-current="page"');
    expect(words).not.toContain('Maple Street Kitchen');
  });

  it('never shows invented numbers, a report period or a sample label unless given', () => {
    const words = text(render(figmaState));
    expect(words).toContain('We never show placeholder numbers.');
    expect(words).not.toContain('Illustrative sample data');
    expect(words).not.toMatch(/Oct|%|sessions/);
    expect(text(render(figmaState, true))).toContain('Illustrative sample data');
  });

  it('labels only finished steps and locks publishing until a menu exists', () => {
    const html = render(figmaState);
    // Success pills: step 1 and the verification card only; steps 2 and 3 have none.
    expect(html.match(/owner-status--success/g)).toHaveLength(2);
    expect(html).toMatch(
      /aria-label="Start: Review and publish"[^>]*disabled|disabled[^>]*aria-label="Start: Review and publish"/,
    );
  });

  it('shows not verified until the team has checked the details', () => {
    const words = text(render({ ...figmaState, detailsVerified: false }));
    expect(words).toContain('Not verified');
    expect(words).toContain('0 of 3 steps complete');
    expect(words).toContain('Add restaurant details');
    expect(words).not.toContain('Review restaurant details');
  });

  it('keeps the AI panel honest: empty state with the composer turned off', () => {
    const html = render(figmaState);
    expect(text(html)).toContain('No questions yet');
    expect(html).toMatch(/id="owner-ai-input"[^>]*disabled/);
  });
});
