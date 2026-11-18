import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_AI_DISH,
  LOCAL_AI_VENUE,
  localOwnerAiReport,
} from '../../scripts/owner-ai-local-fixture';
import { analyzeOwnerReport } from './responses';

const now = new Date('2026-11-12T12:00:00Z');
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
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
function factReply(output: object) {
  const data = reply();
  data.output[0]!.content[0]!.text = JSON.stringify(output);
  return Response.json(data);
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
  it('answers a ranking from the visible historical report when freshness is unknown', async () => {
    const { input, fetchImpl, reserveRequest } = setup();
    const report = structuredClone(input.report);
    Object.assign(report.report_metadata.freshness, { is_stale: null });
    report.dishes.push({
      ...structuredClone(report.dishes[0]!),
      dish_id: '00000000-0000-4000-8000-000000000457',
      name: 'Rice bowl',
    });
    report.dishes[1]!.metrics.open_rate.value = 0.75;
    report.dishes.push({
      ...structuredClone(report.dishes[0]!),
      dish_id: '00000000-0000-4000-8000-000000000458',
      name: 'Rice rolls',
    });
    Object.assign(report.dishes[2]!.metrics.open_rate, { value: null, status: 'SUPPRESSED' });
    fetchImpl.mockResolvedValue(factReply({ operation: 'highest', metric: 'open_rate', limit: 1 }));
    const result = await analyzeOwnerReport({
      ...input,
      report,
      request: { ...input.request, question: 'Which dish had the highest open rate?' },
    });
    expect(result).toMatchObject({
      status: 'answered',
      reason: 'report_fact',
      metric: null,
      value: null,
      answer:
        'Highest open rate among dishes with a reported value: Rice bowl (75%). This describes the displayed historical report. Data freshness is unverified.',
    });
    expect(reserveRequest).toHaveBeenCalledOnce();
    const [, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!;
    const payload = JSON.parse((JSON.parse(init.body as string) as { input: string }).input);
    expect(payload).toMatchObject({
      question: 'Which dish had the highest open rate?',
      report: {
        source: 'synthetic',
        freshness: 'unverified',
        timeWindow: {
          start: report.report_metadata.date_window.start_time,
          end: report.report_metadata.date_window.end_time,
        },
        dishes: [
          {
            name: 'Synthetic development dish',
            selected: true,
            metrics: { open_rate: 0.5, save_rate: 0 },
          },
          { name: 'Rice bowl', selected: false, metrics: { open_rate: 0.75 } },
          { name: 'Rice rolls', selected: false },
        ],
        dishListComplete: true,
      },
    });
    expect(payload.report.dishes[2].metrics).not.toHaveProperty('open_rate');
    expect(init.body).not.toContain('eligible_sessions');
    expect(init.body).not.toContain(LOCAL_AI_VENUE);
    expect(init.body).not.toContain(LOCAL_AI_DISH);
  });
  it('reads displayed and adjacent baseline summary figures without sending unavailable cells', async () => {
    const { input, fetchImpl } = setup();
    const original = input.report;
    const current = {
      start_time: original.report_metadata.date_window.start_time,
      end_time: original.report_metadata.date_window.end_time,
    };
    const baseline = { start_time: '2026-11-10T12:00:00.000Z', end_time: current.start_time };
    const summaryCells = {
      menu_sessions: { value: 20, status: 'NORMAL' },
      dish_opens: { value: 30, status: 'NORMAL' },
      avg_interaction_time_seconds: { value: null, status: 'SUPPRESSED' },
      portion_previews_shown: { value: null, status: 'MISSING' },
      verified_orders: { value: null, status: 'MISSING' },
    };
    const report = {
      ...original,
      summary: {
        periods: { current, baseline },
        current: summaryCells,
        baseline: { ...summaryCells, dish_opens: { value: 25, status: 'NORMAL' } },
      },
    };
    fetchImpl.mockResolvedValue(
      factReply({ operation: 'compare', metric: 'dish_opens', limit: 1 }),
    );
    expect(
      await analyzeOwnerReport({
        ...input,
        report,
        request: {
          ...input.request,
          question: 'How did dish opens compare to the previous period?',
        },
      }),
    ).toMatchObject({
      status: 'answered',
      answer: expect.stringContaining('30 for dish opens in the displayed period and 25'),
    });
    const [, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!;
    const payload = JSON.parse((JSON.parse(init.body as string) as { input: string }).input);
    expect(payload.report.summary).toEqual({
      periods: { current, baseline },
      current: { menu_sessions: 20, dish_opens: 30 },
      baseline: { menu_sessions: 20, dish_opens: 25 },
    });
  });
  it('returns a fact only when the selected report cell exists and permits exposure', async () => {
    const { input, fetchImpl } = setup();
    const request = { ...input.request, question: 'What was this dish’s save rate?' };
    fetchImpl.mockResolvedValue(
      factReply({ operation: 'selected_dish', metric: 'save_rate', limit: 1 }),
    );
    expect(await analyzeOwnerReport({ ...input, request })).toMatchObject({
      status: 'answered',
      answer: expect.stringContaining('recorded 0% for save rate'),
    });
    const report = structuredClone(input.report);
    Object.assign(report.dishes[0]!.metrics.save_rate, { value: null, status: 'SUPPRESSED' });
    fetchImpl.mockResolvedValue(
      factReply({ operation: 'selected_dish', metric: 'save_rate', limit: 1 }),
    );
    expect(await analyzeOwnerReport({ ...input, report, request })).toMatchObject({
      status: 'abstained',
      reason: 'unusable_evidence',
    });
  });
  it('allows explicit abstention and rejects answer text supplied by the provider', async () => {
    const { input, fetchImpl } = setup();
    const request = { ...input.request, question: 'Why did customers spend less?' };
    const abstention = { operation: 'abstain', metric: null, limit: 1 };
    fetchImpl.mockResolvedValue(factReply(abstention));
    expect(await analyzeOwnerReport({ ...input, request })).toMatchObject({
      status: 'abstained',
      reason: 'model_abstained',
    });
    fetchImpl.mockResolvedValue(factReply({ ...abstention, answer: 'invented explanation' }));
    await expect(analyzeOwnerReport({ ...input, request })).rejects.toThrow(
      'Owner analysis unavailable',
    );
  });
  it('withholds facts from a report marked stale before reserving a provider call', async () => {
    const { input, fetchImpl, reserveRequest } = setup();
    Object.assign(input.report.report_metadata.freshness, { is_stale: true });
    expect(
      await analyzeOwnerReport({
        ...input,
        request: { ...input.request, question: 'Which dish had the highest save rate?' },
      }),
    ).toMatchObject({ status: 'abstained', reason: 'unusable_evidence' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reserveRequest).not.toHaveBeenCalled();
  });
  it('accepts the same project ID characters as protected provisioning', async () => {
    const { input, fetchImpl } = setup();
    input.projectId = 'proj_synthetic-branch_1';
    expect(await analyzeOwnerReport(input)).toMatchObject({ status: 'review' });
    const init = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]![1];
    expect(new Headers(init.headers).get('OpenAI-Project')).toBe(input.projectId);
  });
  it('retains only safe provider status and code in a server diagnostic', async () => {
    const { input, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(
      Response.json(
        { error: { code: 'insufficient_quota', message: 'sk-private-response-and-report' } },
        { status: 429 },
      ),
    );
    await expect(analyzeOwnerReport(input)).rejects.toThrow('Owner analysis unavailable');
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('owner_ai_failure', {
      operation: 'owner_analysis',
      category: 'provider_http',
      httpStatus: 429,
      providerCode: 'insufficient_quota',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('distinguishes a timeout from an HTTP rejection without logging exception text', async () => {
    const { input, fetchImpl } = setup();
    fetchImpl.mockRejectedValue(new DOMException('sk-private-exception', 'TimeoutError'));
    await expect(analyzeOwnerReport(input)).rejects.toThrow('Owner analysis unavailable');
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('owner_ai_failure', {
      operation: 'owner_analysis',
      category: 'timeout',
      httpStatus: null,
      providerCode: null,
    });
  });
  it('identifies invalid model output separately from an OpenAI HTTP failure', async () => {
    const { input, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json(reply('not_an_allowed_metric')));
    await expect(analyzeOwnerReport(input)).rejects.toThrow('Owner analysis unavailable');
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('owner_ai_failure', {
      operation: 'owner_analysis',
      category: 'invalid_response',
      httpStatus: 200,
      providerCode: null,
    });
  });
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
