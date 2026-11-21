import { createHash } from 'node:crypto';
import { canonicalJson } from '@peekaplate/contracts';
import type { OwnerDishReport } from '@peekaplate/contracts/owner-report';
import { jwtVerify, SignJWT } from 'jose';

export const OWNER_REPORT_REFERENCE_HEADER = 'X-Owner-Report-Ref';
const referenceLifetime = 60;
const issuer = 'peekaplate-api';
const audience = 'peekaplate-owner-report-analysis';

type ReportScope = { actorId: string; venueId: string };

export function ownerReportSnapshot(report: OwnerDishReport): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        ...report,
        dishes: [...report.dishes].sort((a, b) => a.dish_id.localeCompare(b.dish_id)),
      }),
    )
    .digest('hex');
}

function signingKey(secret: string): Uint8Array {
  if (secret.length < 48 || !/^[\x21-\x7e]+$/.test(secret)) {
    throw new Error('Invalid owner report reference signing configuration');
  }
  return new TextEncoder().encode(secret);
}

export async function mintOwnerReportReference(
  report: OwnerDishReport,
  scope: ReportScope,
  secret: string,
  now: Date,
): Promise<string> {
  const anchor = now.getTime();
  if (
    report.venue_id !== scope.venueId ||
    Date.parse(report.report_metadata.date_window.end_time) !== anchor
  ) {
    throw new Error('Invalid owner report reference scope');
  }
  const issued = Math.floor(anchor / 1000);
  return new SignJWT({
    version: 1,
    venue: scope.venueId,
    source: report.source,
    anchor,
    snapshot: ownerReportSnapshot(report),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(scope.actorId)
    .setIssuedAt(issued)
    .setExpirationTime(issued + referenceLifetime)
    .sign(signingKey(secret));
}

export async function readOwnerReportReference(
  token: string | undefined,
  scope: ReportScope,
  secret: string,
  now: Date,
  source: OwnerDishReport['source'],
): Promise<{ anchor: Date; snapshot: string } | null> {
  if (!token || token.length > 2048) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(secret), {
      algorithms: ['HS256'],
      issuer,
      audience,
      currentDate: now,
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    const { anchor, snapshot } = payload;
    if (
      payload.version !== 1 ||
      payload.sub !== scope.actorId ||
      payload.venue !== scope.venueId ||
      payload.source !== source ||
      typeof anchor !== 'number' ||
      !Number.isSafeInteger(anchor) ||
      anchor > now.getTime() ||
      payload.iat !== Math.floor(anchor / 1000) ||
      payload.exp !== payload.iat + referenceLifetime ||
      typeof snapshot !== 'string' ||
      !/^[a-f0-9]{64}$/.test(snapshot)
    ) {
      return null;
    }
    return { anchor: new Date(anchor), snapshot };
  } catch {
    return null;
  }
}
