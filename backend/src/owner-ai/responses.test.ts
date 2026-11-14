import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_AI_DISH,
  LOCAL_AI_VENUE,
  localOwnerAiReport,
} from '../../scripts/owner-ai-local-fixture';
import { analyzeOwnerReport } from './responses';

const now = new Date('2026-11-12T12:00:00Z');
function reply(metric = 'save_rate') {
  return {
    model: 'gpt-6-luna',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ metric }) }],
      },
    ],
    usage: { input_tokens: 50, output_tokens: 8, total_tokens: 58 },
  };
}
function setup() {
  const fetchImpl = vi.fn(async () => Response.json(reply()));
  const reserveRequest = vi.fn(async () => true);
  const input = {
    report: localOwnerAiReport(now),
    venueId: LOCAL_AI_VENUE,
    request: { dishId: LOCAL_AI_DISH, goal: 'menu' as const },
    now,
    apiKey: 'sk-synthetic-fixture',
    projectId: 'proj_synthetic',
    fetchImpl: fetchImpl as typeof fetch,
    reserveRequest,
  };
  return { input, fetchImpl, reserveRequest };
}
describe('owner Responses adapter', () => {
  it('sends only three public rates, keeps valid zero, and returns server-bound review metadata', async () => {
    const { input, fetchImpl } = setup();
    const result = await analyzeOwnerReport(input);
    expect(result).toMatchObject({
      status: 'review',
      value: 0,
      metric: 'save_rate',
      approvalRequired: true,
      allowedEffects: [],
      venueId: LOCAL_AI_VENUE,
      dishId: LOCAL_AI_DISH,
    });
    expect(result.reportSnapshot).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.redirect).toBe('manual');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      store: false,
      stream: false,
      tools: [],
      tool_choice: 'none',
      max_output_tokens: 128,
    });
    expect(JSON.parse(body.input)).toEqual({
      goal: 'menu',
      metrics: { open_rate: 0.5, engagement_rate: 0.3, save_rate: 0 },
    });
    for (const omitted of [
      'eligible_sessions',
      LOCAL_AI_VENUE,
      LOCAL_AI_DISH,
      'Synthetic development dish',
      input.apiKey,
    ]) {
      expect(init.body).not.toContain(omitted);
    }
  });
  it.each([null, true])(
    'withholds unknown/stale freshness %s without a request',
    async (freshness) => {
      const { input, fetchImpl, reserveRequest } = setup();
      const report = structuredClone(input.report);
      Object.assign(report.report_metadata.freshness, { is_stale: freshness });
      expect(await analyzeOwnerReport({ ...input, report })).toMatchObject({
        status: 'abstained',
        reason: 'unusable_evidence',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(reserveRequest).not.toHaveBeenCalled();
    },
  );
  it.each(['SUPPRESSED', 'MISSING', 'NOT_MEASURABLE', 'STALE', 'EVIDENCE_CHECK_FAILED'])(
    'withholds %s',
    async (status) => {
      const { input, fetchImpl } = setup();
      const report = structuredClone(input.report);
      Object.assign(report.dishes[0]!.metrics.save_rate, { value: null, status });
      expect(await analyzeOwnerReport({ ...input, report })).toMatchObject({ status: 'abstained' });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it('rejects another tenant and private internal fields before model execution', async () => {
    const { input, fetchImpl } = setup();
    await expect(analyzeOwnerReport({ ...input, venueId: LOCAL_AI_DISH })).rejects.toThrow();
    Object.assign(input.report.dishes[0]!.metrics.save_rate, { eligible_sessions: 20 });
    await expect(analyzeOwnerReport(input)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not infer CRM from browsing data', async () => {
    const { input, fetchImpl } = setup();
    expect(
      await analyzeOwnerReport({ ...input, request: { ...input.request, goal: 'crm' } }),
    ).toMatchObject({ reason: 'unsupported_goal' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('honors the server request budget', async () => {
    const { input, fetchImpl, reserveRequest } = setup();
    reserveRequest.mockResolvedValue(false);
    await expect(analyzeOwnerReport(input)).rejects.toThrow('Owner analysis unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([302, 401, 403, 429, 500])(
    'fails closed on provider HTTP %s without retry or provider diagnostics',
    async (status) => {
      const { input, fetchImpl } = setup();
      fetchImpl.mockResolvedValue(new Response('sk-private-error', { status }));
      await expect(analyzeOwnerReport(input)).rejects.toThrow('Owner analysis unavailable');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['incomplete', 'bad-model', 'tool-call', 'bad-usage', 'extra-field', 'refusal'])(
    'rejects %s output',
    async (kind) => {
      const { input, fetchImpl } = setup();
      const data = reply();
      if (kind === 'incomplete') data.status = 'incomplete';
      if (kind === 'bad-model') data.model = 'other';
      if (kind === 'tool-call') data.output[0]!.type = 'function_call';
      if (kind === 'bad-usage') data.usage.total_tokens = 99;
      if (kind === 'extra-field')
        data.output[0]!.content[0]!.text = '{"metric":"open_rate","secret":"extra"}';
      if (kind === 'refusal') data.output[0]!.content[0]!.type = 'refusal';
      fetchImpl.mockResolvedValue(Response.json(data));
      await expect(analyzeOwnerReport(input)).rejects.toThrow('Owner analysis unavailable');
    },
  );
  it('accepts an explicit model abstention without a recommendation', async () => {
    const { input, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json(reply('abstain')));
    expect(await analyzeOwnerReport(input)).toMatchObject({
      status: 'abstained',
      metric: null,
      reason: 'model_abstained',
    });
  });
});
