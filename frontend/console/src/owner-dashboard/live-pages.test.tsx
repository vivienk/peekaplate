import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Actions, Overview, Report } from './pages';

const noop = () => {};
const common = {
  go: noop,
  acts: {},
  setAct: noop,
  sim: { scn: 'A' as const },
  openDish: noop,
  openInsight: noop,
  editDish: noop,
};
const identity = { restaurantName: 'Actual Kitchen' };
const noSamples = (html: string) => {
  expect(html).not.toMatch(
    /Harvest Power Bowl|Avocado Toast|Berry Pancake|1,494|1–14 Sep 2025|Version A|Evidence checked/,
  );
};

describe('authored dashboard pages with live inputs', () => {
  it('renders actual menu identity without prototype images or aggregate metrics', () => {
    const html = renderToStaticMarkup(
      <Overview
        {...common}
        {...{
          live: {
            ...identity,
            menu: [
              {
                id: 'real-1',
                name: 'Actual Soup',
                category: 'Soups',
                priceLabel: 'Price not recorded',
                imageUrl: '/actual-soup.png',
              },
            ],
          },
        }}
      />,
    );
    expect(html).toContain('Actual Kitchen');
    expect(html).toContain('Actual Soup');
    expect(html).toContain('/actual-soup.png');
    expect(html).toContain('Price not recorded');
    expect(html).not.toContain('Menu sessions');
    expect(html).not.toContain('0 planned');
    noSamples(html);
  });

  it('keeps unavailable reports honest and uses the supplied validated report view', () => {
    const absent = renderToStaticMarkup(<Report {...common} {...{ live: identity }} />);
    expect(absent).toContain('Report unavailable');
    expect(absent).not.toContain('Approve');
    noSamples(absent);
    const present = renderToStaticMarkup(
      <Report
        {...common}
        {...{
          live: {
            ...identity,
            period: 'Actual period',
            reportContent: <p>Validated report: Not enough visits yet</p>,
          },
        }}
      />,
    );
    expect(present).toContain('Actual period');
    expect(present).toContain('Validated report: Not enough visits yet');
    noSamples(present);
  });

  it('shows no fabricated actions and renders only explicitly supplied saved actions', () => {
    const empty = renderToStaticMarkup(<Actions {...common} {...{ live: identity }} />);
    expect(empty).toContain('No saved actions');
    expect(empty).not.toContain('Log as done');
    noSamples(empty);
    const saved = renderToStaticMarkup(
      <Actions
        {...common}
        {...{
          live: {
            ...identity,
            actions: [
              {
                id: 'saved-1',
                title: 'Actual saved action',
                text: 'Owner recorded wording',
                status: 'planned' as const,
              },
            ],
          },
        }}
      />,
    );
    expect(saved).toContain('Actual saved action');
    expect(saved).toContain('Owner recorded wording');
    expect(saved).toContain('Planned');
    noSamples(saved);
  });
});
