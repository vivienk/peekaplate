import { jwtVerify, SignJWT } from 'jose';

export type ExtractionSource = { tenantId: string; jobId: string; sourceHash: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const lifetimeSeconds = 15 * 60;
const issuer = 'peekaplate-api';
const audience = 'peekaplate-extraction-staging';
function valid(source: ExtractionSource): boolean {
  return (
    uuid.test(source.tenantId) &&
    uuid.test(source.jobId) &&
    /^[0-9a-f]{64}$/.test(source.sourceHash)
  );
}
function signingKey(secret: string): Uint8Array {
  if (secret.length < 48 || !/^[\x20-\x7e]+$/.test(secret))
    throw new Error('Invalid signing configuration');
  return new TextEncoder().encode(secret);
}

// Call only after the API has authorized/claimed the job, never from browser authority.
export async function mintExtractionCapability(
  source: ExtractionSource,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (!valid(source)) throw new Error('Invalid source scope');
  const issued = Math.floor(now / 1000);
  return new SignJWT({ ...source, version: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(issued)
    .setExpirationTime(issued + lifetimeSeconds)
    .sign(signingKey(secret));
}

export async function readExtractionCapability(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<ExtractionSource | null> {
  try {
    if (!token || token.length > 4096) return null;
    const { payload } = await jwtVerify(token, signingKey(secret), {
      algorithms: ['HS256'],
      issuer,
      audience,
      currentDate: new Date(now),
    });
    const source = {
      tenantId: payload.tenantId,
      jobId: payload.jobId,
      sourceHash: payload.sourceHash,
    };
    if (
      payload.version !== 1 ||
      typeof source.tenantId !== 'string' ||
      typeof source.jobId !== 'string' ||
      typeof source.sourceHash !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp - payload.iat > lifetimeSeconds ||
      payload.iat > Math.floor(now / 1000) + 5
    )
      return null;
    const typed = source as ExtractionSource;
    return valid(typed) ? typed : null;
  } catch {
    return null;
  }
}
