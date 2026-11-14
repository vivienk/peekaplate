// Read once, then remove all URL credentials before mounting or starting provider calls.
export function readConfirmationCode(
  url: string,
  purpose: 'confirmation' | 'recovery' = 'confirmation',
): string | null {
  const callback = new URL(url);
  const codes = callback.searchParams.getAll('code');
  if (
    callback.pathname !== (purpose === 'recovery' ? '/auth-reset.html' : '/auth-confirm.html') ||
    callback.hash ||
    codes.length !== 1 ||
    [...callback.searchParams.keys()].some((key) => key !== 'code')
  )
    return null;
  return codes[0] && /^[A-Za-z0-9._~-]{1,2048}$/.test(codes[0]) ? codes[0] : null;
}
