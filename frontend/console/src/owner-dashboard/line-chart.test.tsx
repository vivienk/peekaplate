import { OwnerReportSummarySchema } from '@peekaplate/contracts/owner-report';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { Overview } from './pages';
import { LineChart } from './ui';

const chart = vi.hoisted(() => ({
  props: null as ComponentProps<typeof import('./ui').ChartCard> | null,
}));
vi.mock('./ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui')>();
  return {
    ...actual,
    ChartCard: (props: ComponentProps<typeof actual.ChartCard>) => {
      chart.props = props;
      return <actual.ChartCard {...props} />;
    },
  };
});

it('wires validated daily buckets into the authored Overview chart and its accessible data table', () => {
  const missing = { value: null, status: 'MISSING' };
  const metrics = {
    menu_sessions: { value: 20, status: 'NORMAL' },
    dish_opens: { value: 25, status: 'NORMAL' },
    avg_interaction_time_seconds: { value: 10, status: 'NORMAL' },
    portion_previews_shown: missing,
    verified_orders: missing,
  };
  const current = [
    {
      start_time: '2026-11-16T12:00:00Z',
      end_time: '2026-11-17T00:00:00Z',
      opens: { value: 12, status: 'NORMAL' },
    },
    {
      start_time: '2026-11-17T00:00:00Z',
      end_time: '2026-11-17T12:00:00Z',
      opens: { value: 13, status: 'NORMAL' },
    },
  ];
  const baseline = current.map((bucket) => ({
    ...bucket,
    start_time: new Date(Date.parse(bucket.start_time) - 86400000).toISOString(),
    end_time: new Date(Date.parse(bucket.end_time) - 86400000).toISOString(),
  }));
  const summary = OwnerReportSummarySchema.parse({
    periods: {
      current: { start_time: current[0]!.start_time, end_time: current[1]!.end_time },
      baseline: { start_time: baseline[0]!.start_time, end_time: baseline[1]!.end_time },
    },
    current: metrics,
    baseline: metrics,
    daily_opens: { current, baseline },
  });
  const noop = () => {};
  const html = renderToStaticMarkup(
    <Overview
      live={{ restaurantName: 'Synthetic chart cafe', menu: [], summary }}
      go={noop}
      sim={{ scn: 'empty' }}
      acts={{}}
      openDish={noop}
      openInsight={noop}
    />,
  );
  expect(html).toContain(
    'Dish opens by clipped UTC day, current period compared with previous period',
  );
  expect(chart.props?.rows).toEqual([
    ['12:00–00:00 UTC', 12, 12],
    ['00:00–12:00 UTC', 13, 13],
  ]);
  expect(html).toContain('View as table');
  expect(html).toContain('12:00–00:00 UTC');
  expect(html).not.toContain('Last week');
  expect(html).toContain('class="ln"');
});

it('breaks the existing chart path at null without plotting a zero or joining across the gap', () => {
  const html = renderToStaticMarkup(
    <LineChart
      labels={['A', 'B', 'C']}
      series={[{ name: 'Observed', color: 'orange', values: [12, null, 20] }]}
    />,
  );
  const path = html.match(/class="ln" d="([^"]*)"/)![1]!;
  expect(path.match(/M/g)).toHaveLength(2);
  expect(path).not.toContain('L');
  expect(html).not.toMatch(/NaN|Infinity/);
});
it('keeps normal numeric lines and renders wholly unavailable series without markers', () => {
  const normal = renderToStaticMarkup(
    <LineChart
      labels={['A', 'B']}
      series={[{ name: 'Observed', color: 'orange', values: [12, 20] }]}
    />,
  );
  expect(normal.match(/class="ln" d="([^"]*)"/)![1]).toContain('L');
  const hidden = renderToStaticMarkup(
    <LineChart
      labels={['A', 'B']}
      series={[{ name: 'Unavailable', color: 'orange', values: [null, null] }]}
    />,
  );
  expect(hidden).toContain('class="ln" d=" "');
  expect(hidden).not.toContain('<circle');
  expect(hidden).not.toMatch(/NaN|Infinity/);
});

it('keeps an isolated first value visible without marking the unavailable final bucket', () => {
  const html = renderToStaticMarkup(
    <LineChart
      labels={['A', 'B']}
      series={[{ name: 'Observed', color: 'orange', values: [12, null] }]}
    />,
  );
  expect(html.match(/<circle\b/g)).toHaveLength(1);
  expect(html).toContain('<circle cx="38"');
  expect(html).not.toContain('<circle cx="622"');
});
