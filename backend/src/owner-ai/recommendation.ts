import {
  MAX_OWNER_AI_CONTEXT_CHARS,
  type OwnerAiMetricKey,
  type OwnerRecommendationRequest,
  OwnerRecommendationRequestSchema,
  type OwnerRecommendationResult,
  OwnerRecommendationResultSchema,
} from '@peekaplate/contracts';

export const OWNER_AI_EXECUTION_LIMITS = Object.freeze({
  maxEvidenceItems: 12,
  maxContextChars: MAX_OWNER_AI_CONTEXT_CHARS,
  maxAttempts: 1,
  maxToolCalls: 0,
  timeoutMs: 5_000,
});

export const OWNER_AI_GENERATOR_VERSION = 'deterministic-rules.v1';

const noCausalClaims =
  'This evidence does not establish diner motive, orders, revenue, or a causal effect.';

export type OwnerRecommendationRule = Readonly<{
  ruleId: string;
  metricKey: OwnerAiMetricKey;
  maximumInclusive: number;
  draftAction: string;
  confidence: 'low' | 'medium' | 'high';
}>;

export class OwnerAiAuthorizationError extends Error {
  constructor() {
    super('Owner recommendation evidence is not authorized');
    this.name = 'OwnerAiAuthorizationError';
  }
}

function sameWindow(
  left: OwnerRecommendationRequest['timeWindow'],
  right: OwnerRecommendationRequest['timeWindow'],
) {
  return left.start === right.start && left.end === right.end;
}

function abstain(
  request: OwnerRecommendationRequest,
  reason: Extract<OwnerRecommendationResult, { status: 'abstained' }>['reason'],
  message: string,
  evidenceRefs: string[],
): OwnerRecommendationResult {
  return OwnerRecommendationResultSchema.parse({
    schemaVersion: 'owner-recommendation.v1',
    requestId: request.requestId,
    reportId: request.reportId,
    reportVersion: request.reportVersion,
    timeWindow: request.timeWindow,
    generatorVersion: OWNER_AI_GENERATOR_VERSION,
    approvalRequired: true,
    allowedEffects: [],
    status: 'abstained',
    reason,
    message,
    evidenceRefs,
  });
}

const abstentionByState = {
  missing: ['missing_evidence', 'Required validated evidence is missing.'],
  suppressed: ['suppressed_evidence', 'The relevant evidence is privacy-suppressed.'],
  stale: ['stale_evidence', 'The relevant evidence is stale.'],
  conflicting: ['conflicting_evidence', 'The relevant evidence is conflicting.'],
  unsupported: ['unsupported_evidence', 'The requested claim is not supported by the report.'],
} as const;

export function buildOwnerRecommendation(
  rawRequest: unknown,
  options: {
    authorizedVenueId: string;
    rules: readonly OwnerRecommendationRule[];
  },
): OwnerRecommendationResult {
  const request = OwnerRecommendationRequestSchema.parse(rawRequest);
  if (request.venueId !== options.authorizedVenueId.toLowerCase()) {
    throw new OwnerAiAuthorizationError();
  }

  let contextChars = request.question?.length ?? 0;
  for (const evidence of request.evidence) {
    if (
      evidence.venueId !== request.venueId ||
      evidence.reportId !== request.reportId ||
      evidence.reportVersion !== request.reportVersion ||
      !sameWindow(evidence.timeWindow, request.timeWindow)
    ) {
      throw new OwnerAiAuthorizationError();
    }
    if (evidence.state === 'available') {
      contextChars += evidence.untrustedSummary?.length ?? 0;
    }
  }
  if (contextChars > OWNER_AI_EXECUTION_LIMITS.maxContextChars) {
    return abstain(
      request,
      'insufficient_evidence',
      'The bounded evidence context is too large.',
      [],
    );
  }
  if (request.evidence.length === 0) {
    return abstain(request, 'missing_evidence', 'No validated report evidence is available.', []);
  }

  const withheld = request.evidence.find((evidence) => evidence.state !== 'available');
  if (withheld) {
    const [reason, message] = abstentionByState[withheld.state];
    return abstain(request, reason, message, [withheld.evidenceId]);
  }

  const match = request.evidence
    .filter((evidence) => evidence.state === 'available')
    .flatMap((evidence) =>
      options.rules
        .filter(
          (rule) =>
            rule.metricKey === evidence.metricKey && evidence.value <= rule.maximumInclusive,
        )
        .map((rule) => ({ evidence, rule })),
    )[0];

  if (!match) {
    return abstain(
      request,
      'unsupported_evidence',
      'No approved recommendation rule matches the validated evidence.',
      request.evidence.map((evidence) => evidence.evidenceId),
    );
  }

  const percentage = (match.evidence.value * 100).toFixed(1);
  return OwnerRecommendationResultSchema.parse({
    schemaVersion: 'owner-recommendation.v1',
    requestId: request.requestId,
    reportId: request.reportId,
    reportVersion: request.reportVersion,
    timeWindow: request.timeWindow,
    generatorVersion: OWNER_AI_GENERATOR_VERSION,
    approvalRequired: true,
    allowedEffects: [],
    status: 'recommendation',
    draftAction: match.rule.draftAction,
    rationale: `${match.evidence.metricKey} was ${percentage}% across ${match.evidence.eligibleSessions} eligible sessions for the selected report window.`,
    evidenceRefs: [match.evidence.evidenceId],
    limitations: [noCausalClaims],
    confidence: match.rule.confidence,
  });
}
