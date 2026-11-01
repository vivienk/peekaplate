import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checks = new Set([
  'lint',
  'typecheck',
  'test',
  'eval:owner-ai',
  'build',
  'context:check',
  'docs:check',
  'test:db',
  'test:e2e',
  'pr:check',
]);

function pnpmSpec(check, environment = process.env) {
  const execPath = environment.npm_execpath;
  if (typeof execPath === 'string' && /^pnpm(?:\.c?js)?$/i.test(basename(execPath))) {
    try {
      if (statSync(execPath).isFile()) {
        return { command: process.execPath, args: [execPath, 'run', check] };
      }
    } catch {}
  }
  return process.platform === 'win32'
    ? { command: `pnpm.cmd run ${check}`, args: [], shell: true }
    : { command: 'pnpm', args: ['run', check] };
}

export function checkSpec(check, environment) {
  if (!checks.has(check)) throw new Error(`Unknown check: ${check}`);
  return check === 'pr:check'
    ? { command: process.execPath, args: ['scripts/check-pr.mjs'] }
    : pnpmSpec(check, environment);
}

export function validateChecks(checkNames) {
  if (!checkNames.length) throw new Error('Usage: node scripts/verify.mjs <check>...');
  return checkNames.map(checkSpec);
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolveResult) => {
    let spawnError;
    const child = spawn(command, args, {
      cwd: root,
      shell: options.shell === true,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      spawnError = error.message;
    });
    child.once('close', (exitCode, signal) => {
      resolveResult({
        exitCode: spawnError ? null : exitCode,
        signal: spawnError ? null : signal,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
}

export function validGitHubRunUrl(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' &&
      /^https:\/\/github\.com\//.test(value) &&
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(url.pathname) &&
      !url.search &&
      !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function githubRunUrl(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY;
  const runId = environment.GITHUB_RUN_ID;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(runId ?? '')) return null;
  return validGitHubRunUrl(`https://github.com/${repository}/actions/runs/${runId}`);
}

export function defaultLedger(environment = process.env) {
  return resolve(root, environment.CI ? 'work/errors.md' : 'errors.md');
}

export async function recordFailure(result, options = {}) {
  if (!checks.has(result.check)) throw new Error(`Unknown check: ${result.check}`);
  const entry = {
    kind: 'automatic-check-observation',
    check: result.check,
    timestamp: new Date().toISOString(),
    ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
    ...(typeof result.signal === 'string' && Object.hasOwn(constants.signals, result.signal)
      ? { signal: result.signal }
      : {}),
    ...(validGitHubRunUrl(options.githubRunUrl)
      ? { githubRunUrl: validGitHubRunUrl(options.githubRunUrl) }
      : {}),
  };
  const record = `\n<!-- automatic observation; not root cause -->\n\`\`\`json\n${JSON.stringify(entry)}\n\`\`\`\n`;
  const ledger = options.ledger ?? defaultLedger();
  await mkdir(dirname(ledger), { recursive: true });
  await appendFile(ledger, record);
  if (options.summary) {
    await mkdir(dirname(options.summary), { recursive: true });
    await appendFile(
      options.summary,
      `\n- Check \`${entry.check}\` failed at ${entry.timestamp}${entry.exitCode !== undefined ? ` (exit ${entry.exitCode})` : ` (signal ${entry.signal ?? 'spawn failure'})`}${entry.githubRunUrl ? `: ${entry.githubRunUrl}` : ''}\n`,
    );
  }
}

export async function runChecks(checkNames, options = {}) {
  const specs = validateChecks(checkNames).map((_, index) =>
    checkSpec(checkNames[index], options.environment),
  );
  const execute = options.execute ?? ((spec) => runProcess(spec.command, spec.args, spec));
  for (let index = 0; index < specs.length; index += 1) {
    const result = await execute(specs[index]);
    if (result.exitCode === 0 && !result.signal && !result.spawnError) continue;
    try {
      await recordFailure(
        { check: checkNames[index], ...result },
        {
          ledger: options.ledger ?? defaultLedger(options.environment),
          summary: options.summary ?? options.environment?.GITHUB_STEP_SUMMARY,
          githubRunUrl: options.githubRunUrl ?? githubRunUrl(options.environment),
        },
      );
    } catch (error) {
      console.warn(`Could not record failed check: ${error.message}`);
    }
    return result;
  }
  return { exitCode: 0, signal: null };
}

async function main() {
  try {
    const result = await runChecks(process.argv.slice(2), { environment: process.env });
    if (result.exitCode === 0 && !result.signal && !result.spawnError) return;
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.exitCode ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
