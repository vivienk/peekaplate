// Pages redirects .html entries to clean URLs; accept only those exact same-purpose aliases.
export function isAuthCallbackPath(pathname: string, purpose: 'confirmation' | 'recovery') {
  const path = purpose === 'recovery' ? '/auth-reset' : '/auth-confirm';
  return pathname === path || pathname === `${path}.html`;
}

// Read once, then remove all URL credentials before mounting or starting provider calls.
export function readConfirmationCode(
  url: string,
  purpose: 'confirmation' | 'recovery' = 'confirmation',
): string | null {
  const callback = new URL(url);
  const codes = callback.searchParams.getAll('code');
  if (
    !isAuthCallbackPath(callback.pathname, purpose) ||
    callback.hash ||
    codes.length !== 1 ||
    [...callback.searchParams.keys()].some((key) => key !== 'code')
  )
    return null;
  return codes[0] && /^[A-Za-z0-9._~-]{1,2048}$/.test(codes[0]) ? codes[0] : null;
}
