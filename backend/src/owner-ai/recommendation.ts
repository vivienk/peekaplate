import {
  MAX_OWNER_AI_CONTEXT_CHARS,
  MAX_OWNER_AI_EVIDENCE,
  type OwnerAiActionId,
  type OwnerRecommendationPolicy,
  OwnerRecommendationPolicySchema,
  type OwnerRecommendationRequest,
  OwnerRecommendationRequestSchema,
  type OwnerRecommendationResult,
  OwnerRecommendationResultSchema,
} from '@peekaplate/contracts';

export const OWNER_AI_EXECUTION_LIMITS = Object.freeze({
  maxEvidenceItems: MAX_OWNER_AI_EVIDENCE,
  maxContextChars: MAX_OWNER_AI_CONTEXT_CHARS,
  maxAttempts: 1,
  maxToolCalls: 0,
  timeoutMs: 5_000,
});

export const OWNER_AI_GENERATOR_VERSION = 'deterministic-rules.v1';

const noCausalClaims =
  'This evidence does not establish diner motive, orders, revenue, or a causal effect.';

const actionText: Record<OwnerAiActionId, string> = {
  review_dish_card: 'Review the approved dish-card presentation before the next publication.',
  review_dish_detail: 'Review the approved dish-detail clarity before the next publication.',
  review_save_affordance: 'Review the approved Save affordance before the next publication.',
};

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

function resultBase(request: OwnerRecommendationRequest, policyVersion: string) {
  return {
    schemaVersion: 'owner-recommendation.v1' as const,
    requestId: request.requestId,
    venueId: request.venueId,
    reportId: request.reportId,
    reportVersion: request.reportVersion,
    timeWindow: request.timeWindow,
    generatorVersion: OWNER_AI_GENERATOR_VERSION,
    policyVersion,
    approvalRequired: true as const,
    allowedEffects: [] as [],
  };
}

function validateResultForRequest(
  result: OwnerRecommendationResult,
  request: OwnerRecommendationRequest,
): OwnerRecommendationResult {
  if (
    result.requestId !== request.requestId ||
    result.venueId !== request.venueId ||
    result.reportId !== request.reportId ||
    result.reportVersion !== request.reportVersion ||
    !sameWindow(result.timeWindow, request.timeWindow)
  ) {
    throw new OwnerAiAuthorizationError();
  }
  const allowedEvidenceIds = new Set(request.evidence.map((evidence) => evidence.evidenceId));
  if (result.evidenceRefs.some((evidenceId) => !allowedEvidenceIds.has(evidenceId))) {
    throw new OwnerAiAuthorizationError();
  }
  return result;
}

export function validateOwnerRecommendationResult(
  rawResult: unknown,
  rawRequest: unknown,
  rawPolicy: unknown,
): OwnerRecommendationResult {
  const request = OwnerRecommendationRequestSchema.parse(rawRequest);
  const policy = OwnerRecommendationPolicySchema.parse(rawPolicy);
  const result = OwnerRecommendationResultSchema.parse(rawResult);
  const expected = buildOwnerRecommendation(request, {
    authorizedVenueId: request.venueId,
    policy,
  });
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new OwnerAiAuthorizationError();
  }
  return result;
}

function abstain(
  request: OwnerRecommendationRequest,
  policyVersion: string,
  reason: Extract<OwnerRecommendationResult, { status: 'abstained' }>['reason'],
  message: string,
  evidenceRefs: string[],
): OwnerRecommendationResult {
  return validateResultForRequest(
    OwnerRecommendationResultSchema.parse({
      ...resultBase(request, policyVersion),
      status: 'abstained',
      reason,
      message,
      evidenceRefs,
    }),
    request,
  );
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
    policy: unknown;
  },
): OwnerRecommendationResult {
  const request = OwnerRecommendationRequestSchema.parse(rawRequest);
  const policy: OwnerRecommendationPolicy = OwnerRecommendationPolicySchema.parse(options.policy);
  if (request.venueId !== options.authorizedVenueId.toLowerCase()) {
    throw new OwnerAiAuthorizationError();
  }

  let contextChars = 0;
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
      policy.policyVersion,
      'insufficient_evidence',
      'The bounded evidence context is too large.',
      [],
    );
  }
  if (request.evidence.length === 0) {
    return abstain(
      request,
      policy.policyVersion,
      'missing_evidence',
      'No validated report evidence is available.',
      [],
    );
  }

  const withheld = request.evidence.find((evidence) => evidence.state !== 'available');
  if (withheld) {
    const [reason, message] = abstentionByState[withheld.state];
    return abstain(request, policy.policyVersion, reason, message, [withheld.evidenceId]);
  }

  const matches = request.evidence
    .filter((evidence) => evidence.state === 'available')
    .flatMap((evidence) =>
      policy.rules
        .filter(
          (rule) =>
            rule.metricKey === evidence.metricKey && evidence.value <= rule.maximumInclusive,
        )
        .map((rule) => ({ evidence, rule })),
    )
    .sort(
      (left, right) =>
        left.rule.priority - right.rule.priority ||
        left.rule.ruleId.localeCompare(right.rule.ruleId) ||
        left.evidence.evidenceId.localeCompare(right.evidence.evidenceId),
    );
  const match = matches[0];

  if (!match) {
    return abstain(
      request,
      policy.policyVersion,
      'unsupported_evidence',
      'No approved recommendation rule matches the validated evidence.',
      request.evidence.map((evidence) => evidence.evidenceId),
    );
  }

  const percentage = (match.evidence.value * 100).toFixed(1);
  return validateResultForRequest(
    OwnerRecommendationResultSchema.parse({
      ...resultBase(request, policy.policyVersion),
      status: 'recommendation',
      ruleId: match.rule.ruleId,
      actionId: match.rule.actionId,
      draftAction: actionText[match.rule.actionId],
      rationale: `${match.evidence.metricKey} was ${percentage}% across ${match.evidence.eligibleSessions} eligible sessions for the selected report window.`,
      evidenceRefs: [match.evidence.evidenceId],
      limitations: [noCausalClaims],
      confidence: match.rule.confidence,
    }),
    request,
  );
}
