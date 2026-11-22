import { describe, expect, it } from 'vitest';
import { matchReportQuestion, ownerDashboardPages } from './OwnerWorkspace';

describe('live workspace dashboard admission', () => {
  it('keeps unverified and unknown setup on saved-menu management', () => {
    expect([...ownerDashboardPages('owner', false, null)]).toEqual(['setup', 'menu']);
    expect([...ownerDashboardPages('owner', false, false)]).toEqual(['setup', 'menu']);
  });
  it('opens existing dashboard branches only after verification or confirmed publication', () => {
    for (const [verified, published] of [
      [true, false],
      [false, true],
    ] as const)
      expect([...ownerDashboardPages('owner', verified, published)]).toEqual([
        'setup',
        'overview',
        'report',
        'performance',
        'menu',
        'actions',
      ]);
  });
  it('never grants editors or unknown membership owner reports/actions', () => {
    expect([...ownerDashboardPages('editor', true, true)]).toEqual(['setup', 'menu']);
    expect([...ownerDashboardPages(undefined, true, true)]).toEqual(['setup', 'menu']);
  });
});

describe('typed report questions', () => {
  it('maps only supported report intents before a request is made', () => {
    expect(matchReportQuestion('How is engagement for this dish?')).toBe('engagement');
    expect(matchReportQuestion('Dish saves')).toBe('menu');
    expect(matchReportQuestion('Customer retention')).toBe('crm');
    expect(matchReportQuestion('Which dish gets the most attention?')).toBeNull();
    expect(matchReportQuestion('Show engagement on Monday')).toBeNull();
    expect(matchReportQuestion('Tell me a joke')).toBeNull();
  });
});
