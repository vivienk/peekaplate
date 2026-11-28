// Overview date filter: preset and custom ranges as whole UTC days. Reports are in UTC, so a range
// is a list of calendar days, and `toUtcWindow` turns it into a half-open window (start included,
// end excluded) for the report request. "Last N days" ends yesterday, as complete days only.

export const DATE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'this-week', label: 'This week (Sun – Today)' },
  { id: 'last-7', label: 'Last 7 days' },
  { id: 'last-week', label: 'Last week (Sun – Sat)' },
  { id: 'last-28', label: 'Last 28 days' },
  { id: 'last-30', label: 'Last 30 days' },
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number]['id'];

/** First and last day shown to the owner, both included, as YYYY-MM-DD in UTC. */
export type DateRange = { preset: DatePreset | 'custom'; start: string; end: string };

/** The same range as a half-open UTC window for a report request. */
export type UtcWindow = { start_time: string; end_time: string };

const DAY = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const midnight = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY);

export function presetRange(preset: DatePreset, now: Date): DateRange {
  const today = midnight(now);
  const sunday = addDays(today, -today.getUTCDay());
  const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const span = (start: Date, end: Date): DateRange => ({
    preset,
    start: dayOf(start),
    end: dayOf(end),
  });
  const lastDays = (days: number) => span(addDays(today, -days), addDays(today, -1));
  switch (preset) {
    case 'today':
      return span(today, today);
    case 'yesterday':
      return span(addDays(today, -1), addDays(today, -1));
    case 'this-week':
      return span(sunday, today);
    case 'last-7':
      return lastDays(7);
    case 'last-week':
      return span(addDays(sunday, -7), addDays(sunday, -1));
    case 'last-28':
      return lastDays(28);
    case 'last-30':
      return lastDays(30);
    case 'this-month':
      return span(firstOfMonth, today);
    case 'last-month':
      return span(
        new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
        addDays(firstOfMonth, -1),
      );
  }
}

/** A custom range is valid when both days exist, start is not after end, and end is not in the future. */
export function customRange(start: string, end: string, now: Date): DateRange | null {
  if (!ISO_DAY.test(start) || !ISO_DAY.test(end)) return null;
  const from = new Date(`${start}T00:00:00Z`);
  const to = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (dayOf(from) !== start || dayOf(to) !== end) return null;
  if (from > to || to > midnight(now)) return null;
  return { preset: 'custom', start, end };
}

export function toUtcWindow(range: DateRange): UtcWindow {
  return {
    start_time: `${range.start}T00:00:00.000Z`,
    end_time: `${dayOf(addDays(new Date(`${range.end}T00:00:00Z`), 1))}T00:00:00.000Z`,
  };
}

const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Oct 27 – Nov 23, 2026", or one day "Nov 24, 2026". */
export function formatRange(range: DateRange): string {
  const from = new Date(`${range.start}T00:00:00Z`);
  const to = new Date(`${range.end}T00:00:00Z`);
  if (range.start === range.end) return LONG.format(to);
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  return `${(sameYear ? SHORT : LONG).format(from)} – ${LONG.format(to)}`;
}

export function presetLabel(preset: DateRange['preset']): string {
  return DATE_PRESETS.find((p) => p.id === preset)?.label ?? 'Custom';
}
