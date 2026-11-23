export const PRODUCTION_OWNER_API_ORIGIN = 'https://api.peekaplate.app';

const API_ORIGINS = new Set([
  'http://127.0.0.1:8787',
  'https://peekaplate-api-staging.vxkong.workers.dev',
  PRODUCTION_OWNER_API_ORIGIN,
]);

export function readWorkspaceApiBase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return API_ORIGINS.has(url.origin) &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
