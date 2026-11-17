// Where the S13 phone loads the diner menu from, matched to the console it runs in: a PR preview
// shows the same PR's diner preview, staging shows the staging diner and a local console shows the
// local diner dev server. Anything else shows no diner rather than guessing an address.
export function dinerPreviewUrl(location: { protocol: string; hostname: string }): string | null {
  const pr = /^pr-(\d+)\.peekaplate-console-preview\.pages\.dev$/.exec(location.hostname);
  if (location.protocol === 'https:' && pr) {
    return `https://pr-${pr[1]}.peekaplate-diner-preview.pages.dev/`;
  }
  if (
    location.protocol === 'https:' &&
    location.hostname === 'peekaplate-console-staging.pages.dev'
  ) {
    return 'https://peekaplate-diner-staging.pages.dev/';
  }
  if (location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname)) {
    return 'http://127.0.0.1:5173/';
  }
  return null;
}
