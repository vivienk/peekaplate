import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const staging = 'https://peekaplate-api-staging.vxkong.workers.dev';
const window = 'from=2026-10-20T06:00:00Z&until=2026-10-20T07:00:00Z';
const usage = 'Usage: node scripts/verify-team-access.mjs --login YOUR_GITHUB_USERNAME';

async function readToken() {
  const { stdout } = await execute('gh', ['auth', 'token', '--hostname', 'github.com'], {
    timeout: 10_000,
    maxBuffer: 8192,
    windowsHide: true,
  });
  return stdout.trim();
}

export async function verifyTeamDenial({
  expectedLogin,
  getToken = readToken,
  request = fetch,
  progress = console.log,
  timeoutMs = 10_000,
}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(expectedLogin ?? '')) {
    throw new Error(usage);
  }
  progress('Starting read-only staging denial check. There is no token-entry prompt.');
  progress('Reading your current GitHub CLI credential (10-second timeout)...');
  let token;
  try {
    token = await getToken();
    if (typeof token !== 'string' || !/^\S+$/.test(token) || token.length > 8192) throw new Error();
  } catch {
    throw new Error(
      'GitHub CLI credential unavailable. Run gh auth login --hostname github.com, then retry.',
    );
  }
  const checks = [];
  const get = (url) =>
    request(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  progress('Checking GitHub identity...');
  let user;
  try {
    const response = await get('https://api.github.com/user');
    checks.push({ endpoint: 'github/user', status: response.status });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { passed: false, checks, reason: 'GitHub identity must return 200' };
    }
    user = await response.json();
  } catch {
    return { passed: false, checks, reason: 'GitHub identity request failed or timed out' };
  }
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(user?.login ?? '') ||
    user.type !== 'User' ||
    !Number.isSafeInteger(user.id) ||
    user.id < 1 ||
    user.login.toLowerCase() !== expectedLogin.toLowerCase()
  ) {
    return {
      passed: false,
      checks,
      reason: 'GitHub identity does not match --login; check your active gh account',
    };
  }
  progress(`GitHub identity: 200, ${user.login}`);
  for (const endpoint of ['events', 'summary']) {
    progress(`Checking staging ${endpoint}...`);
    const check = { endpoint, status: null, forbidden: false };
    try {
      const response = await get(`${staging}/team/analytics/${endpoint}?${window}&limit=1`);
      check.status = response.status;
      const id = response.headers.get('X-Request-ID');
      if (/^[0-9a-f-]{36}$/i.test(id ?? '')) check.requestId = id;
      // Never read or print analytics data when access unexpectedly succeeds.
      if (response.status === 403) check.forbidden = (await response.json())?.error === 'forbidden';
      else await response.body?.cancel();
    } catch {
      check.error = 'Request failed, timed out or returned invalid denial JSON';
    }
    checks.push(check);
    progress(
      `${endpoint}: ${check.status ?? 'ERROR'}${check.forbidden ? ' forbidden' : ' (not a verified denial)'}`,
    );
  }
  return {
    passed: checks.slice(1).every((check) => check.status === 403 && check.forbidden),
    verifiedAt: new Date().toISOString(),
    login: user.login,
    checks,
  };
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { login: { type: 'string' }, help: { type: 'boolean' } } }));
  } catch {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    console.log(
      `${usage}\nUses your current gh sign-in; no token is entered, printed or saved. Expected: GitHub 200, events 403, summary 403.`,
    );
    return;
  }
  try {
    const report = await verifyTeamDenial({ expectedLogin: values.login });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      report.passed
        ? 'PASS: both non-collaborator denial checks passed.'
        : 'FAIL: hosted denial is not verified.',
    );
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    console.error(
      `FAIL: check --login and run gh auth login --hostname github.com before retrying. ${usage}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
