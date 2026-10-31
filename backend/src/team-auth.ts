import { AuthenticationError, AuthUnavailableError } from './auth';
import { CommandError } from './dish-command';

type Config = { APP_ENV?: string; TEAM_GITHUB_TOKEN?: string; LOCAL_GITHUB_API_URL?: string };

export async function verifyTeamCollaborator(
  authorization: string,
  env: Config,
  request: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<void> {
  if (!/^Bearer [^\s]+$/i.test(authorization) || authorization.length > 8192)
    throw new AuthenticationError();
  if (!env.TEAM_GITHUB_TOKEN) throw new AuthUnavailableError();
  let origin = 'https://api.github.com';
  if (env.APP_ENV === 'local' && env.LOCAL_GITHUB_API_URL) {
    const url = new URL(env.LOCAL_GITHUB_API_URL);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new AuthUnavailableError();
    origin = url.origin;
  }
  const get = (path: string, credential: string) =>
    request(`${origin}${path}`, {
      headers: {
        Authorization: credential,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PeekaPlate-Team-Analytics',
      },
      // Workers supports manual/follow; 3xx responses below fail closed without forwarding tokens.
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
  try {
    const userResponse = await get('/user', authorization);
    if (userResponse.status === 401) throw new AuthenticationError();
    if (!userResponse.ok) throw new AuthUnavailableError();
    const user = (await userResponse.json()) as { id?: unknown; login?: unknown; type?: unknown };
    if (
      typeof user.id !== 'number' ||
      !Number.isSafeInteger(user.id) ||
      user.id < 1 ||
      user.type !== 'User' ||
      typeof user.login !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(user.login)
    )
      throw new AuthenticationError();
    // Use the server credential only for the fixed repository membership check.
    const membership = await get(
      `/repos/vivienk/peekaplate/collaborators/${encodeURIComponent(user.login)}`,
      `Bearer ${env.TEAM_GITHUB_TOKEN}`,
    );
    if (membership.status === 404) throw new CommandError('forbidden', 403);
    if (membership.status !== 204) throw new AuthUnavailableError();
  } catch (error) {
    if (
      error instanceof AuthenticationError ||
      error instanceof CommandError ||
      error instanceof AuthUnavailableError
    )
      throw error;
    throw new AuthUnavailableError();
  }
}
