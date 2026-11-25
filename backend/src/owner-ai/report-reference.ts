import { createHash } from 'node:crypto';
import { canonicalJson } from '@peekaplate/contracts';
import {
  isOwnerProductionCalendarVersion,
  OWNER_PRODUCTION_BATCH_VERSION,
  type OwnerDishReport,
} from '@peekaplate/contracts/owner-report';
import { jwtVerify, SignJWT } from 'jose';
import {
  latestOwnerReportBatchEnd,
  OWNER_BATCH_MS,
  ownerReportDayWindow,
} from '../owner-report-batches';

export const OWNER_REPORT_REFERENCE_HEADER = 'X-Owner-Report-Ref';
const referenceLifetime = 60;
const issuer = 'peekaplate-api';
const audience = 'peekaplate-owner-report-analysis';

type ReportScope = { actorId: string; venueId: string };
type VerifiedReportReference = { anchor: Date; snapshot: string; displayActions?: true };

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
  displayActions = false,
): Promise<string> {
  const anchor = now.getTime();
  const metadata = report.report_metadata;
  const productionBatch =
    report.source === 'production' &&
    metadata.calculation_version === OWNER_PRODUCTION_BATCH_VERSION;
  const day =
    report.source === 'production' && isOwnerProductionCalendarVersion(metadata.calculation_version)
      ? ownerReportDayWindow(now)
      : undefined;
  const expectedEnd =
    day?.end.getTime() ?? (productionBatch ? latestOwnerReportBatchEnd(now) : anchor);
  const expectedStart =
    day?.start.getTime() ?? (productionBatch ? expectedEnd - OWNER_BATCH_MS : undefined);
  const window = day ? report.summary?.periods.current : metadata.date_window;
  if (
    report.venue_id !== scope.venueId ||
    !window ||
    Date.parse(window.end_time) !== expectedEnd ||
    (expectedStart !== undefined && Date.parse(window.start_time) !== expectedStart)
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
    ...(displayActions ? { displayActions: true } : {}),
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
): Promise<VerifiedReportReference | null> {
  if (!token || token.length > 2048) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(secret), {
      algorithms: ['HS256'],
      issuer,
      audience,
      currentDate: now,
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    const { anchor, snapshot, displayActions } = payload;
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
      (displayActions !== undefined && displayActions !== true) ||
      typeof snapshot !== 'string' ||
      !/^[a-f0-9]{64}$/.test(snapshot)
    ) {
      return null;
    }
    return { anchor: new Date(anchor), snapshot, ...(displayActions ? { displayActions } : {}) };
  } catch {
    return null;
  }
}
