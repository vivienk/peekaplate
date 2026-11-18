import {
  type OwnerAnalysisRequest,
  type OwnerAnalysisResult,
  OwnerAnalysisResultSchema,
} from '@peekaplate/contracts/owner-analysis';
import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { z } from 'zod';
import {
  isOwnerAiProjectId,
  logOwnerAiFailure,
  OwnerAiProviderFailure,
  requestOwnerAiResponse,
} from './provider';
import {
  ownerReportFactInput,
  renderReportFact,
  reportFactFormat,
  reportFactInstructions,
} from './report-facts';
import { ownerReportSnapshot } from './report-reference';

export const OWNER_ANALYSIS_MODEL = 'gpt-6-luna';
export const OWNER_ANALYSIS_MAX_TOKENS = 128;
const selectionSchema = z.strictObject({
  metric: z.enum(['open_rate', 'engagement_rate', 'save_rate', 'abstain']),
});
const keys = ['open_rate', 'engagement_rate', 'save_rate'] as const;
const providerEnvelopeSchema = z.object({
  status: z.literal('completed'),
  model: z
    .string()
    .refine(
      (model) => model === OWNER_ANALYSIS_MODEL || /^gpt-6-luna-\d{4}-\d{2}-\d{2}$/.test(model),
    ),
  output: z.array(z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().positive(),
    output_tokens: z.number().int().positive(),
    total_tokens: z.number().int().positive(),
  }),
});
const providerMessageSchema = z.object({
  type: z.literal('message'),
  role: z.literal('assistant'),
  status: z.literal('completed'),
  content: z.tuple([z.object({ type: z.literal('output_text'), text: z.string() })]),
});

/** Provider output remains untrusted; both adapters apply the same envelope limits. */
export function ownerAiOutputText(value: unknown, maxOutputTokens: number): string {
  const data = providerEnvelopeSchema.parse(value);
  const messages = data.output.filter(
    (item) => !(item && typeof item === 'object' && 'type' in item && item.type === 'reasoning'),
  );
  const { input_tokens: input, output_tokens: output, total_tokens: total } = data.usage;
  if (messages.length !== 1 || output > maxOutputTokens || total !== input + output) {
    throw new Error('Invalid owner AI response');
  }
  return providerMessageSchema.parse(messages[0]).content[0].text;
}

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
    reportSnapshot: ownerReportSnapshot(report),
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
  const { question, goal } = options.request;
  // The recommendation flow cannot infer retention from browsing.
  if (!question && goal === 'crm') return abstain('unsupported_goal');
  const age = options.now.getTime() - Date.parse(meta.generated_at);
  if (
    meta.report_status !== 'NORMAL' ||
    meta.freshness.is_stale === true ||
    age < 0 ||
    Date.parse(meta.date_window.end_time) > options.now.getTime() ||
    (!question &&
      (meta.freshness.is_stale !== false ||
        dish.evidence_state !== 'NORMAL' ||
        age > 300_000 ||
        keys.some((key) => !['NORMAL', 'VALID_ZERO'].includes(dish.metrics[key].status))))
  ) {
    return abstain('unusable_evidence');
  }
  const task = question
    ? {
        instructions: reportFactInstructions,
        input: JSON.stringify(ownerReportFactInput(report, dish, question)),
        text: { format: reportFactFormat },
      }
    : {
        instructions:
          'Select one supplied browsing metric for a human to review, or abstain. These are synthetic data. Do not infer sales, customer identity, retention, revenue, causality, or industry benchmarks. A low rate alone does not prove a problem. No tools or changes are authorized.',
        input: JSON.stringify({
          goal,
          metrics: Object.fromEntries(keys.map((key) => [key, dish.metrics[key].value])),
        }),
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
      };
  let httpStatus: number | null = null;
  try {
    if (!options.apiKey || !isOwnerAiProjectId(options.projectId)) {
      throw new OwnerAiProviderFailure({ category: 'configuration', httpStatus: null });
    }
    // A reservation failure is local, never evidence of an OpenAI HTTP rejection.
    let reserved = false;
    try {
      reserved = await options.reserveRequest();
    } catch {
      throw new OwnerAiProviderFailure({ category: 'request_budget', httpStatus: null });
    }
    if (!reserved)
      throw new OwnerAiProviderFailure({ category: 'request_budget', httpStatus: null });
    const response = await requestOwnerAiResponse({
      apiKey: options.apiKey,
      projectId: options.projectId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      body: {
        model: OWNER_ANALYSIS_MODEL,
        store: false,
        stream: false,
        reasoning: { effort: 'none' },
        max_output_tokens: OWNER_ANALYSIS_MAX_TOKENS,
        tools: [],
        tool_choice: 'none',
        ...task,
      },
    });
    httpStatus = response.httpStatus;
    const output: unknown = JSON.parse(ownerAiOutputText(response.data, OWNER_ANALYSIS_MAX_TOKENS));
    if (question) {
      const fact = renderReportFact(report, dish, question, output);
      if ('reason' in fact) return abstain(fact.reason);
      return OwnerAnalysisResultSchema.parse({
        ...base,
        ...fact,
        status: 'answered',
        metric: null,
        value: null,
        reason: 'report_fact',
      });
    }
    const choice = selectionSchema.parse(output);
    if (choice.metric === 'abstain') return abstain('model_abstained');
    return OwnerAnalysisResultSchema.parse({
      ...base,
      status: 'review',
      metric: choice.metric,
      value: dish.metrics[choice.metric].value,
      reason: 'review_evidence',
    });
  } catch (error) {
    logOwnerAiFailure('owner_analysis', error, { category: 'invalid_response', httpStatus });
    // Provider diagnostics are server-only; public errors and result contracts stay generic.
    throw new OwnerAnalysisUnavailable();
  }
}
