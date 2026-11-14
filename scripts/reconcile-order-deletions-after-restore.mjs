#!/usr/bin/env node
/**
 * Operational entry point for post-restore order-data deletion reconciliation (S6-DATA-14).
 *
 * Prerequisites:
 * - OPERATOR_DATABASE_URL: PostgreSQL connection string for peekaplate_operator_login
 *   (member of peekaplate_deletion_operator; never use peekaplate_runtime).
 * - RECONCILIATION_OPERATOR_ID: Canonical UUID of the authorized operator.
 * - R2_ENDPOINT: S3-compatible R2 endpoint (https://<account_id>.r2.cloudflarestorage.com).
 * - R2_BUCKET: R2 bucket name holding order-imports/ and order-deletion-ledger/.
 * - R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY: R2 S3 API credentials with read/write/delete scope.
 * - ORDER_DELETION_AUTHORIZED_OPERATOR_IDS (optional): Comma-separated authorized operator UUIDs.
 * - Restored database traffic must remain frozen until this script exits 0 and lifts
 *   app_private.system_gates('order_imports_restore_freeze').
 */

import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateReconcileCliEnv(env) {
  const operatorDatabaseUrl = env.OPERATOR_DATABASE_URL?.trim();
  const operatorId = env.RECONCILIATION_OPERATOR_ID?.trim();

  if (!operatorDatabaseUrl) {
    throw new Error('OPERATOR_DATABASE_URL is required (must not reuse runtime credentials)');
  }
  if (!operatorId || !UUID_RE.test(operatorId)) {
    throw new Error('RECONCILIATION_OPERATOR_ID must be a valid canonical UUID');
  }
  return { operatorDatabaseUrl, operatorId };
}

export function validateR2S3Env(env) {
  const endpoint = env.R2_ENDPOINT?.trim().replace(/\/+$/, '');
  const bucket = env.R2_BUCKET?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required',
    );
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const XML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXmlEntities(str) {
  return str.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

function parseListObjectsV2Xml(xml) {
  const truncatedMatch = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/);
  if (!/<ListBucketResult[\s>]/i.test(xml) || !truncatedMatch) {
    throw new Error('Malformed ListObjectsV2 XML response from R2');
  }
  const objects = [];
  const keyRe = /<Key>([\s\S]*?)<\/Key>/g;
  for (const match of xml.matchAll(keyRe)) {
    objects.push({ key: decodeXmlEntities(match[1]) });
  }
  const truncated = truncatedMatch[1] === 'true';
  const tokenMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
  const cursor = tokenMatch ? decodeXmlEntities(tokenMatch[1]) : undefined;
  return { objects, truncated, cursor };
}

export function createR2S3Storage(config) {
  const { endpoint, bucket, accessKeyId, secretAccessKey, fetchImpl = fetch } = config;
  const parsedEndpoint = new URL(endpoint);
  const host = parsedEndpoint.host;
  const region = 'auto';
  const service = 's3';

  async function signedRequest(method, objectKey, queryParams = {}, body = '', headers = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);

    const encodedKey = objectKey ? objectKey.split('/').map(encodeRfc3986).join('/') : '';
    const canonicalUri = `/${encodeRfc3986(bucket)}${encodedKey ? `/${encodedKey}` : ''}`;

    const sortedQuery = Object.entries(queryParams)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(String(v))}`)
      .join('&');

    const baseHeaders = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    };

    const sortedHeaderKeys = Object.keys(baseHeaders).sort();
    const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${baseHeaders[k]}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      sortedQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    const kSigning = hmacSha256(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `${parsedEndpoint.origin}${canonicalUri}${sortedQuery ? `?${sortedQuery}` : ''}`;

    return fetchImpl(url, {
      method,
      headers: {
        ...baseHeaders,
        Authorization: authorization,
      },
      body: method === 'PUT' ? body : undefined,
    });
  }

  return {
    async list({ prefix, cursor, limit = 100 }) {
      const res = await signedRequest('GET', '', {
        'continuation-token': cursor,
        'list-type': '2',
        'max-keys': String(limit),
        prefix,
      });
      if (!res.ok) {
        throw new Error(`R2 list failed with HTTP ${res.status}`);
      }
      const xml = await res.text();
      return parseListObjectsV2Xml(xml);
    },
    async get(key) {
      const res = await signedRequest('GET', key);
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`R2 get(${key}) failed with HTTP ${res.status}`);
      }
      const text = await res.text();
      return {
        async json() {
          return JSON.parse(text);
        },
      };
    },
    async put(key, body, opts) {
      const contentType = opts?.httpMetadata?.contentType ?? 'application/octet-stream';
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      const res = await signedRequest('PUT', key, {}, payload, { 'content-type': contentType });
      if (!res.ok) {
        throw new Error(`R2 put(${key}) failed with HTTP ${res.status}`);
      }
    },
    async delete(key) {
      const res = await signedRequest('DELETE', key);
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 delete(${key}) failed with HTTP ${res.status}`);
      }
    },
  };
}

async function defaultCreateClient(connectionString) {
  const pgMod = await import('pg').catch(() => import('../backend/node_modules/pg/esm/index.mjs'));
  const ClientCtor = pgMod.Client ?? pgMod.default?.Client;
  if (!ClientCtor) {
    throw new Error('Unable to load pg Client');
  }
  return new ClientCtor({ connectionString });
}

async function defaultReconcileFn(options) {
  const mod = await import('../backend/src/order-ingestion/restore-reconciliation.ts');
  return mod.reconcileOrderDeletionsAfterRestore(options);
}

export async function runReconcileCli({
  env = process.env,
  createClient = defaultCreateClient,
  createStorage = createR2S3Storage,
  reconcileFn = defaultReconcileFn,
  log = console.log,
} = {}) {
  const { operatorDatabaseUrl, operatorId } = validateReconcileCliEnv(env);
  const r2Config = validateR2S3Env(env);

  const rawAuthorized = env.ORDER_DELETION_AUTHORIZED_OPERATOR_IDS?.trim();
  const authorizedOperatorIds = new Set(
    rawAuthorized
      ? rawAuthorized
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [operatorId],
  );

  const storage = createStorage(r2Config);
  const client = await createClient(operatorDatabaseUrl);

  await client.connect();
  try {
    const result = await reconcileFn({
      client,
      operatorId,
      authorizedOperatorIds,
      verificationStorage: storage,
      storage,
    });
    log(
      JSON.stringify({
        event: 'restore_reconciliation_finished',
        ...result,
      }),
    );
    const ok = result.status === 'completed' && result.anomalyCount === 0 && result.freezeLifted;
    return { exitCode: ok ? 0 : 1, result };
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
  runReconcileCli()
    .then(({ exitCode }) => {
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
