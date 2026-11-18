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
    expect(matchReportQuestion('Which dish gets the most attention?')).toBe('engagement');
    expect(matchReportQuestion('Why do diners save this dish?')).toBe('menu');
    expect(matchReportQuestion('What is customer retention?')).toBe('crm');
    expect(matchReportQuestion('Tell me a joke')).toBeNull();
  });
});
