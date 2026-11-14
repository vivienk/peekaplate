export function shouldOpenDining(
  path: string,
  search: string,
  userAgent: string,
  enabled: boolean,
) {
  if (!enabled || path !== '/') return false;
  const mode = new URLSearchParams(search).get('experience');
  if (mode === 'menu') return false;
  return mode === 'quest' || /OculusBrowser|Meta Quest/i.test(userAgent);
}
