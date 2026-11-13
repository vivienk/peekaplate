import { createHash } from 'node:crypto';
import {
  type OwnerAnalysisRequest,
  type OwnerAnalysisResult,
  OwnerAnalysisResultSchema,
} from '@peekaplate/contracts/owner-analysis';
import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { z } from 'zod';

export const OWNER_ANALYSIS_MODEL = 'gpt-6-luna';
export const OWNER_ANALYSIS_MAX_TOKENS = 128;
const selectionSchema = z.strictObject({
  metric: z.enum(['open_rate', 'engagement_rate', 'save_rate', 'abstain']),
});
const keys = ['open_rate', 'engagement_rate', 'save_rate'] as const;
export class OwnerAnalysisUnavailable extends Error {
  constructor() {
    super('Owner analysis unavailable');
  }
}

/** Input must come from the authorized server report reader, never from the browser. */
export async function analyzeOwnerReport(options: {
  report: unknown;
  venueId: string;
  request: OwnerAnalysisRequest;
  now: Date;
  apiKey: string;
  projectId: string;
  fetchImpl?: typeof fetch;
  reserveRequest: () => Promise<boolean>;
}): Promise<OwnerAnalysisResult> {
  const report = OwnerDishReportSchema.parse(options.report);
  const meta = report.report_metadata;
  const dish = report.dishes.find((item) => item.dish_id === options.request.dishId);
  if (report.venue_id !== options.venueId || report.source !== 'synthetic' || !dish) {
    throw new OwnerAnalysisUnavailable();
  }
  const base = {
    schemaVersion: 'owner-analysis.v1' as const,
    venueId: report.venue_id,
    dishId: dish.dish_id,
    goal: options.request.goal,
    source: 'synthetic' as const,
    reportSnapshot: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
    timeWindow: { start: meta.date_window.start_time, end: meta.date_window.end_time },
    approvalRequired: true as const,
    allowedEffects: [] as [],
  };
  const abstain = (reason: 'unusable_evidence' | 'unsupported_goal' | 'model_abstained') =>
    OwnerAnalysisResultSchema.parse({
      ...base,
      status: 'abstained',
      metric: null,
      value: null,
      reason,
    });
  // This report has no CRM/customer/order evidence. Never infer retention from browsing.
  if (options.request.goal === 'crm') return abstain('unsupported_goal');
  const age = options.now.getTime() - Date.parse(meta.generated_at);
  if (
    meta.report_status !== 'NORMAL' ||
    meta.freshness.is_stale !== false ||
    dish.evidence_state !== 'NORMAL' ||
    age < 0 ||
    age > 300_000 ||
    Date.parse(meta.date_window.end_time) > options.now.getTime() ||
    keys.some((key) => !['NORMAL', 'VALID_ZERO'].includes(dish.metrics[key].status))
  ) {
    return abstain('unusable_evidence');
  }
  if (!options.apiKey || !/^proj_[A-Za-z0-9]+$/.test(options.projectId)) {
    throw new OwnerAnalysisUnavailable();
  }
  if (!(await options.reserveRequest())) throw new OwnerAnalysisUnavailable();
  const metrics = Object.fromEntries(keys.map((key) => [key, dish.metrics[key].value]));
  try {
    const response = await (options.fetchImpl ?? fetch)('https://api.openai.com/v1/responses', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'OpenAI-Project': options.projectId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OWNER_ANALYSIS_MODEL,
        store: false,
        stream: false,
        reasoning: { effort: 'none' },
        max_output_tokens: OWNER_ANALYSIS_MAX_TOKENS,
        tools: [],
        tool_choice: 'none',
        instructions:
          'Select one supplied browsing metric for a human to review, or abstain. These are synthetic data. Do not infer sales, customer identity, retention, revenue, causality, or industry benchmarks. A low rate alone does not prove a problem. No tools or changes are authorized.',
        input: JSON.stringify({ goal: options.request.goal, metrics }),
        text: {
          format: {
            type: 'json_schema',
            name: 'owner_review_metric',
            strict: true,
            schema: {
              type: 'object',
              properties: { metric: { type: 'string', enum: [...keys, 'abstain'] } },
              required: ['metric'],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (!response.ok) throw new OwnerAnalysisUnavailable();
    // A bounded response prevents unexpected provider payloads from reaching the UI or logs.
    const raw = await response.text();
    if (raw.length > 32_768) throw new OwnerAnalysisUnavailable();
    const data = JSON.parse(raw);
    if (
      data.status !== 'completed' ||
      (data.model !== OWNER_ANALYSIS_MODEL && !/^gpt-6-luna-\d{4}-\d{2}-\d{2}$/.test(data.model))
    ) {
      throw new OwnerAnalysisUnavailable();
    }
    const messages = data.output?.filter((item: { type: string }) => item.type !== 'reasoning');
    const message = messages?.[0];
    if (
      messages?.length !== 1 ||
      message?.type !== 'message' ||
      message.role !== 'assistant' ||
      message.status !== 'completed' ||
      message.content?.length !== 1 ||
      message.content[0]?.type !== 'output_text'
    )
      throw new OwnerAnalysisUnavailable();
    const usage = data.usage;
    if (
      !usage ||
      ![usage.input_tokens, usage.output_tokens, usage.total_tokens].every(Number.isSafeInteger) ||
      usage.input_tokens <= 0 ||
      usage.output_tokens <= 0 ||
      usage.output_tokens > OWNER_ANALYSIS_MAX_TOKENS ||
      usage.total_tokens !== usage.input_tokens + usage.output_tokens
    )
      throw new OwnerAnalysisUnavailable();
    const choice = selectionSchema.parse(JSON.parse(message.content[0].text));
    if (choice.metric === 'abstain') return abstain('model_abstained');
    return OwnerAnalysisResultSchema.parse({
      ...base,
      status: 'review',
      metric: choice.metric,
      value: dish.metrics[choice.metric].value,
      reason: 'review_evidence',
    });
  } catch {
    // Never expose provider errors, credentials, response text or unvalidated model prose.
    throw new OwnerAnalysisUnavailable();
  }
}
