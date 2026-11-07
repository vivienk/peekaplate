import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkPullRequest, isPullRequestCheckApplicable } from './check-pr.mjs';

const body = `## Outcome
Reject stale publication commands.
## Contract and context
- Spec, issue, or ADR: ADR 0002
- Data/API/migration impact: Existing API returns conflict.
- Documentation or ADR update: ADR 0002 and context updated.
## Changes
Check expected version inside the transaction.
## Verification
- PASS: \`pnpm test\` (regression included)
## Deferred / future work
N/A
`;

test('accepts a populated PR and rejects missing evidence, empty fields and untouched template', async () => {
  assert.doesNotThrow(() => checkPullRequest(body));
  assert.throws(() => checkPullRequest(body.replace('PASS:', 'Maybe:')), /Verification/);
  assert.throws(
    () => checkPullRequest(body.replace('PASS: `pnpm test` (regression included)', 'PASS green')),
    /Verification/,
  );
  assert.throws(() => checkPullRequest(body.replace('ADR 0002\n', '\n')), /field/);
  assert.throws(() => checkPullRequest(body.replace('## Outcome', '## Missing')), /section/);
  const template = await readFile(
    new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url),
    'utf8',
  );
  assert.throws(() => checkPullRequest(template));
});

test('PR body check is required only for non-draft pull_request events', () => {
  assert.equal(isPullRequestCheckApplicable('push', { draft: false }), false);
  assert.equal(isPullRequestCheckApplicable('pull_request', { draft: true }), false);
  assert.equal(isPullRequestCheckApplicable('pull_request', { draft: false }), true);
});
