import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type SignalName =
  | 'eligible_exposure_events'
  | 'readable_detail_open_events'
  | 'qualifying_comparison_events'
  | 'direct_save_events';

type FixtureCase = {
  id: string;
  description: string;
  input: Record<string, string[]>;
  expected: Partial<Record<SignalName, number>>;
};

type Fixture = {
  fixture_version: string;
  contract_status: string;
  score: {
    value: number | null;
    status: string;
    reason: string;
  };
  cases: FixtureCase[];
};

const fixturePath = fileURLToPath(
  new URL('./descriptive_signals.json', import.meta.url),
);

const fixture = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as Fixture;

const signalInputs: Record<SignalName, string> = {
  eligible_exposure_events: 'eligible_exposure_event_ids',
  readable_detail_open_events: 'readable_detail_open_event_ids',
  qualifying_comparison_events: 'qualifying_comparison_event_ids',
  direct_save_events: 'direct_save_event_ids',
};

describe('DATA-06 independent descriptive-signal fixtures', () => {
  it('keeps the contract proposed and numeric score unavailable', () => {
    expect(fixture.contract_status).toBe('PROPOSED');
    expect(fixture.score).toEqual({
      value: null,
      status: 'MISSING',
      reason: 'POLICY_PENDING',
    });
  });

  it('contains five uniquely identified synthetic cases', () => {
    expect(fixture.cases).toHaveLength(5);

    const ids = fixture.cases.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(fixture.cases)(
    '$id: $description',
    (testCase) => {
      for (const [signal, expectedCount] of Object.entries(
        testCase.expected,
      )) {
        const inputKey = signalInputs[signal as SignalName];
        expect(inputKey).toBeDefined();

        const eventIds = testCase.input[inputKey];
        expect(Array.isArray(eventIds)).toBe(true);

        const distinctCount = new Set(eventIds).size;
        expect(distinctCount).toBe(expectedCount);
      }
    },
  );

  it('does not count Undo events as direct Saves', () => {
    const saveCase = fixture.cases.find(
      (testCase) => testCase.id === 'D06-SAVE-01',
    );

    expect(saveCase).toBeDefined();
    expect(saveCase!.input.undo_event_ids).toHaveLength(1);
    expect(
      new Set(saveCase!.input.direct_save_event_ids).size,
    ).toBe(2);
    expect(saveCase!.expected.direct_save_events).toBe(2);
  });
});
