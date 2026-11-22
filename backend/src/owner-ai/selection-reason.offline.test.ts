import type { OwnerAnalysisRequest } from '@peekaplate/contracts/owner-analysis';
import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_AI_DISH,
  LOCAL_AI_VENUE,
  localOwnerAiReport,
} from '../../scripts/owner-ai-local-fixture';
import { analyzeOwnerReport } from './responses';

const now = new Date('2026-11-12T12:00:00Z');
const approvedPairs = {
  MENU_CARD_OPEN_SIGNAL: { goal: 'menu', metric: 'open_rate' },
  ENGAGEMENT_GOAL_MATCH: { goal: 'engagement', metric: 'engagement_rate' },
} as const;
type ReasonCode = keyof typeof approvedPairs;
type Metric = (typeof approvedPairs)[ReasonCode]['metric'];

// The reason is fixture metadata for this acceptance test. The adapter still receives its
// existing metric-only provider response and applies the real evidence checks and report binding.
function setup(
  goal: OwnerAnalysisRequest['goal'],
  metric: Metric,
  reason: ReasonCode,
  wireOutput: { metric: Metric; selection_reason?: ReasonCode } = { metric },
) {
  const report = localOwnerAiReport(now);
  const reserveRequest = vi.fn(async () => true);
  const fetchImpl = vi.fn(async () =>
    Response.json({
      model: 'gpt-6-luna',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(wireOutput) }],
        },
      ],
      usage: { input_tokens: 50, output_tokens: 8, total_tokens: 58 },
    }),
  );
  const analyze = () =>
    analyzeOwnerReport({
      report,
      venueId: LOCAL_AI_VENUE,
      request: { dishId: LOCAL_AI_DISH, goal },
      now,
      apiKey: 'sk-offline-fixture',
      projectId: 'proj_synthetic',
      fetchImpl,
      reserveRequest,
    });

  return {
    report,
    fetchImpl,
    reserveRequest,
    async evaluate() {
      const analysis = await analyze();
      if (analysis.status === 'abstained') return { status: 'abstained', analysis };
      const expected = approvedPairs[reason];
      if (analysis.goal !== expected.goal || analysis.metric !== expected.metric) {
        return { status: 'reason_mismatch' };
      }
      return { status: 'review', analysis, reason };
    },
  };
}

describe('owner AI v1 selection reason offline acceptance', () => {
  it.each([
    ['menu', 'open_rate', 'MENU_CARD_OPEN_SIGNAL', 0.5],
    ['engagement', 'engagement_rate', 'ENGAGEMENT_GOAL_MATCH', 0.3],
  ] as const)('accepts %s / %s / %s with current evidence', async (goal, metric, reason, value) => {
    const { report, evaluate, fetchImpl } = setup(goal, metric, reason);
    const { start_time, end_time } = report.report_metadata.date_window;
    expect(await evaluate()).toMatchObject({
      status: 'review',
      reason,
      analysis: {
        status: 'review',
        metric,
        value,
        venueId: LOCAL_AI_VENUE,
        dishId: LOCAL_AI_DISH,
        timeWindow: { start: start_time, end: end_time },
        approvalRequired: true,
        allowedEffects: [],
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['menu', 'engagement_rate', 'MENU_CARD_OPEN_SIGNAL'],
    ['engagement', 'open_rate', 'ENGAGEMENT_GOAL_MATCH'],
    ['menu', 'engagement_rate', 'ENGAGEMENT_GOAL_MATCH'],
    ['engagement', 'open_rate', 'MENU_CARD_OPEN_SIGNAL'],
  ] as const)('withholds a mismatched %s / %s / %s', async (goal, metric, reason) => {
    const { evaluate, fetchImpl } = setup(goal, metric, reason);
    expect(await evaluate()).toEqual({ status: 'reason_mismatch' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['menu', 'open_rate', 'MENU_CARD_OPEN_SIGNAL'],
    ['engagement', 'engagement_rate', 'ENGAGEMENT_GOAL_MATCH'],
  ] as const)('abstains for %s when %s is suppressed', async (goal, metric, reason) => {
    const { report, evaluate, fetchImpl, reserveRequest } = setup(goal, metric, reason);
    Object.assign(report.dishes[0]!.metrics[metric], { status: 'SUPPRESSED', value: null });
    expect(await evaluate()).toMatchObject({
      status: 'abstained',
      analysis: { status: 'abstained', reason: 'unusable_evidence', metric: null, value: null },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reserveRequest).not.toHaveBeenCalled();
  });

  it('abstains before the provider when report freshness is unknown', async () => {
    const { report, evaluate, fetchImpl, reserveRequest } = setup(
      'engagement',
      'engagement_rate',
      'ENGAGEMENT_GOAL_MATCH',
    );
    Object.assign(report.report_metadata.freshness, { is_stale: null });
    expect(await evaluate()).toMatchObject({
      status: 'abstained',
      analysis: { status: 'abstained', reason: 'unusable_evidence', metric: null, value: null },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reserveRequest).not.toHaveBeenCalled();
  });

  it('rejects selection_reason on the current provider wire format', async () => {
    const { evaluate, fetchImpl } = setup('menu', 'open_rate', 'MENU_CARD_OPEN_SIGNAL', {
      metric: 'open_rate',
      selection_reason: 'MENU_CARD_OPEN_SIGNAL',
    });
    await expect(evaluate()).rejects.toThrow('Owner analysis unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
