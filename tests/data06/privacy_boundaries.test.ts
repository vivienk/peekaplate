import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type PrivacyCase = {
  id: string;
  description: string;
  eligible_session_ids: string[];
  expected: {
    privacy_floor_met?: boolean;
    distinct_eligible_sessions?: number;
    value?: number | null;
    status?: string;
  };
};

type PrivacyFixture = {
  contract_status: string;
  minimum_eligible_sessions: number;
  cases: PrivacyCase[];
};

const fixturePath = fileURLToPath(
  new URL('./privacy_boundaries.json', import.meta.url),
);

const fixture = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as PrivacyFixture;

describe('DATA-06 independent privacy-boundary fixtures', () => {
  it('keeps the contract proposed and the privacy floor at ten sessions', () => {
    expect(fixture.contract_status).toBe('PROPOSED');
    expect(fixture.minimum_eligible_sessions).toBe(10);
  });

  it('contains three uniquely identified privacy cases', () => {
    expect(fixture.cases).toHaveLength(3);
    expect(new Set(fixture.cases.map(c => c.id)).size).toBe(3);
  });

  it.each(fixture.cases)('$id: $description', (testCase) => {
    const distinctSessions = new Set(testCase.eligible_session_ids).size;
    const privacyFloorMet =
      distinctSessions >= fixture.minimum_eligible_sessions;

    if (testCase.expected.distinct_eligible_sessions !== undefined) {
      expect(distinctSessions).toBe(
        testCase.expected.distinct_eligible_sessions,
      );
    }

    if (testCase.expected.privacy_floor_met !== undefined) {
      expect(privacyFloorMet).toBe(testCase.expected.privacy_floor_met);
    }

    if (testCase.expected.status === 'SUPPRESSED') {
      expect(privacyFloorMet).toBe(false);
      expect(testCase.expected.value).toBeNull();
    }
  });
});
