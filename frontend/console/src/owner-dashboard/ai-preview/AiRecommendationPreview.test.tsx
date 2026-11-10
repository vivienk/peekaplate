import {
  type OwnerRecommendationResult,
  OwnerRecommendationResultSchema,
} from '@peekaplate/contracts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type AiPreviewState, AiRecommendationPreview } from './AiRecommendationPreview';
import { syntheticAbstention, syntheticRecommendation } from './fixtures';

const render = (state: AiPreviewState) =>
  renderToStaticMarkup(<AiRecommendationPreview state={state} />);

describe('synthetic AI result preview', () => {
  it('renders the existing typed recommendation as a review-only synthetic draft', () => {
    expect(OwnerRecommendationResultSchema.safeParse(syntheticRecommendation).success).toBe(true);
    const html = render({ kind: 'result', result: syntheticRecommendation });
    expect(html).toContain('Synthetic AI preview');
    expect(html).toContain('No live restaurant data is loaded');
    expect(html).toContain('Draft recommendation');
    expect(html).toContain(
      syntheticRecommendation.status === 'recommendation' && syntheticRecommendation.draftAction,
    );
    expect(html).toContain('Review required. This preview cannot apply changes.');
    expect(html).toContain('2026-10-05');
    expect(html).toContain('2026-10-12');
    expect(html).not.toMatch(/<button|<form|eligibleSessions|eligible_sessions/);
  });

  it('renders an abstention without interpreting it as a recommendation or zero', () => {
    expect(OwnerRecommendationResultSchema.safeParse(syntheticAbstention).success).toBe(true);
    const html = render({ kind: 'result', result: syntheticAbstention });
    expect(html).toContain('No recommendation');
    expect(html).toContain('evidence needed for a recommendation is unavailable');
    expect(html).not.toContain('Draft recommendation');
    expect(html).not.toContain('0%');
  });

  it.each([
    ['loading', 'Loading the synthetic example', 'status'],
    ['error', 'The example could not be displayed', 'alert'],
    ['insufficient-evidence', 'Not enough usable evidence', 'status'],
    ['withheld', 'Evidence withheld', 'status'],
  ] as const)('keeps %s as a local UI state, separate from the wire result', (kind, copy, role) => {
    const html = render({ kind });
    expect(html).toContain('Synthetic AI preview');
    expect(html).toContain(copy);
    expect(html).toContain(`role="${role}"`);
    expect(html).not.toContain('Draft recommendation');
    expect(html).toContain(`aria-busy="${kind === 'loading'}"`);
    expect(
      OwnerRecommendationResultSchema.safeParse({ ...syntheticAbstention, status: kind }).success,
    ).toBe(false);
  });

  it.each([
    { eligibleSessions: 987654 },
    { internalReport: { eligible_sessions: 987654 } },
    { approvalRequired: false },
    { allowedEffects: ['publish'] },
    { status: 'loading' },
  ])('fails closed on an invalid or internal payload without printing its contents', (change) => {
    const result = {
      ...syntheticRecommendation,
      ...change,
    } as unknown as OwnerRecommendationResult;
    const html = render({ kind: 'result', result });
    expect(html).toContain('The example could not be verified');
    expect(html).not.toContain('Draft recommendation');
    expect(html).not.toContain('987654');
    expect(html).not.toContain('eligible');
    expect(html).not.toContain('publish');
  });

  it('uses fixed abstention copy rather than raw producer diagnostics or hidden counts', () => {
    const result = {
      ...syntheticAbstention,
      status: 'abstained' as const,
      reason: 'suppressed_evidence' as const,
      message: 'INTERNAL DIAGNOSTIC: eligibleSessions=987654',
    };
    const html = render({ kind: 'result', result });
    expect(html).toContain('This evidence is withheld');
    expect(html).not.toContain('INTERNAL DIAGNOSTIC');
    expect(html).not.toContain('987654');
  });

  it('treats recommendation text as text rather than executable markup', () => {
    if (syntheticRecommendation.status !== 'recommendation') throw new Error('Wrong fixture');
    const result = { ...syntheticRecommendation, draftAction: '<script>alert("example")</script>' };
    const html = render({ kind: 'result', result });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
