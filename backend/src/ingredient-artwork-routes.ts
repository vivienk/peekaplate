import { createHash } from 'node:crypto';
import { ArtworkCommandSchema, ArtworkLabelSchema, VenueScopeSchema } from '@peekaplate/contracts';
import type { Context, Hono } from 'hono';
import type { Client } from 'pg';
import { AuthenticationError, AuthUnavailableError } from './auth';
import type { Bindings } from './index';
import { IngestionError } from './ingestion/repository';
import { artworkKey, readArtwork, reviewArtwork } from './ingredient-artwork';

type Services = {
  verify(authorization: string, env: Bindings): Promise<string>;
  authorizeVenue(actor: string, venue: string, env: Bindings): Promise<void>;
  database<T>(env: Bindings, work: (client: Client) => Promise<T>): Promise<T>;
};
export function registerArtworkRoutes(app: Hono<{ Bindings: Bindings }>, services: Services) {
  const scope = (c: Context<{ Bindings: Bindings }>) => {
    c.header('Cache-Control', 'no-store');
    if (c.env?.INGREDIENT_ARTWORK_ENABLED !== 'true') throw new IngestionError('not_found', 404);
    const parsed = VenueScopeSchema.safeParse({ venueId: c.req.param('venueId') });
    if (!parsed.success) throw new IngestionError('invalid_request', 400);
    return parsed.data.venueId.toLowerCase();
  };
  const staff = async (c: Context<{ Bindings: Bindings }>) => {
    const venue = scope(c);
    const authorization = c.req.header('Authorization');
    if (!authorization) throw new AuthenticationError();
    const actor = await services.verify(authorization, c.env);
    await services.authorizeVenue(actor, venue, c.env);
    return { actor, venue };
  };
  app.get('/venues/:venueId/ingredient-icons', async (c) => {
    const { venue } = await staff(c);
    const label = ArtworkLabelSchema.safeParse(c.req.query('label'));
    if (!label.success) return c.json({ error: 'invalid_request' }, 400);
    const states = await services.database(c.env, (client) =>
      readArtwork(client, venue, [label.data]),
    );
    return c.json({ state: states[0] ?? null });
  });
  app.post('/venues/:venueId/ingredient-icons/review', async (c) => {
    const { actor, venue } = await staff(c);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? ''))
      return c.json({ error: 'unsupported_media_type' }, 415);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const input = ArtworkCommandSchema.safeParse(raw);
    if (!input.success) return c.json({ error: 'invalid_request' }, 400);
    const bucket = c.env.INGESTION_REPORTS_BUCKET;
    if (!bucket) throw new AuthUnavailableError();
    const state = await services.database(c.env, (client) =>
      reviewArtwork(client, actor, venue, input.data, bucket),
    );
    return c.json({ state });
  });
  app.get('/public/venues/:venueId/ingredient-icons', async (c) => {
    const venue = scope(c);
    const raw = c.req.queries('label') ?? [];
    if (
      !raw.length ||
      raw.length > 100 ||
      raw.some((label) => !ArtworkLabelSchema.safeParse(label).success)
    )
      return c.json({ error: 'invalid_request' }, 400);
    const states = await services.database(c.env, (client) =>
      readArtwork(client, venue, [...new Set(raw)]),
    );
    return c.json({ schemaVersion: 1, icons: states.filter((s) => s.status === 'approved') });
  });
  app.get('/public/venues/:venueId/ingredient-icons/image', async (c) => {
    const venue = scope(c);
    const label = ArtworkLabelSchema.safeParse(c.req.query('label'));
    const hash = c.req.query('sha256') ?? '';
    if (!label.success || !/^[a-f0-9]{64}$/.test(hash))
      return c.json({ error: 'invalid_request' }, 400);
    const approved = async () =>
      (await services.database(c.env, (client) => readArtwork(client, venue, [label.data]))).some(
        (state) => state.status === 'approved' && state.sha256 === hash,
      );
    if (!(await approved())) return c.json({ error: 'not_found' }, 404);
    const bucket = c.env.INGESTION_REPORTS_BUCKET;
    if (!bucket?.get) throw new AuthUnavailableError();
    const object = await bucket.get(artworkKey(venue, hash));
    if (!object || object.size > 1_000_000) return c.json({ error: 'not_found' }, 404);
    const bytes = await object.arrayBuffer();
    if (
      bytes.byteLength > 1_000_000 ||
      createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== hash
    )
      throw new AuthUnavailableError();
    // Recheck after the storage read so a withdrawn pointer cannot serve old bytes.
    if (!(await approved())) return c.json({ error: 'not_found' }, 404);
    c.header('Content-Type', 'image/png');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(bytes);
  });
}
