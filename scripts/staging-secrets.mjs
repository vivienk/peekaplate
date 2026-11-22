import { pathToFileURL } from 'node:url';

export function stagingSecrets(env) {
  if (!env.TEAM_GITHUB_TOKEN) throw new Error('Missing staging team token');
  const values = { TEAM_GITHUB_TOKEN: env.TEAM_GITHUB_TOKEN };
  if (env.CONFIGURE_OWNER_AI === 'true') {
    if (
      !env.OWNER_AI_OPENAI_API_KEY ||
      !/^proj_[A-Za-z0-9_-]+$/.test(env.OWNER_AI_OPENAI_PROJECT_ID ?? '') ||
      !/^[\x21-\x7e]{48,}$/.test(env.OWNER_AI_REPORT_REFERENCE_SECRET ?? '')
    )
      throw new Error('Owner AI key, project ID or reference secret is missing or invalid');
    for (const key of [
      'OWNER_AI_OPENAI_API_KEY',
      'OWNER_AI_OPENAI_PROJECT_ID',
      'OWNER_AI_REPORT_REFERENCE_SECRET',
    ])
      values[key] = env[key];
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify(stagingSecrets(process.env)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
