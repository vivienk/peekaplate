// The consent gate (S3-TRK-01.2). One flag, read only here, so the real rule can replace it later.
// Off by default: until the consent model is decided (P1; opt-in or notice-only), no live event is
// queued or sent. Fixture mode does not consult it, because it never sends anything (Adam).
let allowed = false;

export function isTrackingAllowed(): boolean {
  return allowed;
}

export function setTrackingAllowed(value: boolean): void {
  allowed = value;
}
