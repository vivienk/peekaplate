import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkPullRequest(body) {
  if (typeof body !== 'string') throw new Error('PR body is required');
  const sections = new Map(
    [...body.matchAll(/^## ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map((match) => [
      match[1].trim(),
      match[2].trim(),
    ]),
  );
  for (const name of [
    'Outcome',
    'Contract and context',
    'Changes',
    'Verification',
    'Deferred / future work',
  ]) {
    const value = sections.get(name);
    if (
      !value ||
      value === '-' ||
      /Describe the user or operator result|State only intentionally deferred|List exact commands and results|Replace this paragraph/.test(
        value,
      )
    )
      throw new Error(`Complete PR section: ${name}`);
  }
  for (const label of [
    'Spec, issue, or ADR',
    'Data/API/migration impact',
    'Documentation or ADR update',
  ]) {
    const line = sections
      .get('Contract and context')
      .split('\n')
      .find((item) => item.startsWith(`- ${label}:`));
    const value = line?.slice(label.length + 3).trim();
    if (!value || /\[ \]|why:\s*$/.test(value) || /^N\/?A\s*$/i.test(value))
      throw new Error(`Explain PR field: ${label}`);
  }
  const entries = [
    ...sections
      .get('Verification')
      .matchAll(/^\s*-\s*(PASS|FAIL|NOT RUN):\s*`([^`\n]+)`([^\n]*)$/gm),
  ];
  if (
    !entries.some(
      ([, status, command, detail]) => command.trim() && (status !== 'NOT RUN' || detail.trim()),
    )
  )
    throw new Error('Verification needs - PASS|FAIL|NOT RUN: `exact command`; explain NOT RUN');
}

export function isPullRequestCheckApplicable(eventName, pullRequest) {
  return eventName === 'pull_request' && !pullRequest?.draft;
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (!isPullRequestCheckApplicable(process.env.GITHUB_EVENT_NAME, event.pull_request)) {
    console.log('PR body check not applicable to this event.');
    return;
  }
  checkPullRequest(event.pull_request?.body);
  console.log('PR sections and verification declaration present; human review checks accuracy.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
