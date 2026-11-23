import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SYNTHETIC_DIR = path.join(REPO_ROOT, 'test-data/owner-synthetic-p0-v2');
const FRONTEND_DATA_PATH = path.join(REPO_ROOT, 'frontend/console/src/owner-dashboard/data.ts');

describe('S7-DATA-15 synthetic dashboard scope and determinism', () => {
  it('declares explicit supported_metrics with unit, source, and unavailability conditions in manifest.json', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SYNTHETIC_DIR, 'manifest.json'), 'utf8'),
    ) as {
      supported_metrics: Array<{
        name: string;
        unit: string;
        source: string;
        unavailable_conditions: string[];
      }>;
      unavailable_metrics: {
        verified_orders: { status: string; reason: string };
      };
    };

    expect(manifest.supported_metrics.map((m) => m.name)).toEqual([
      'active_sessions',
      'open_rate',
      'engagement_rate',
      'save_rate',
      'avg_interaction_time_seconds',
      'timing_coverage',
    ]);

    for (const metric of manifest.supported_metrics) {
      expect(metric.unit.length).toBeGreaterThan(0);
      expect(metric.source).toMatch(/^app_private\.owner_(observation|opening_activity)_v1$/);
      expect(metric.unavailable_conditions.length).toBeGreaterThanOrEqual(2);
    }

    expect(manifest.unavailable_metrics.verified_orders.status).toBe('UNAVAILABLE');
  });

  it('keeps verified orders explicitly unavailable across frontend synthetic dashboard fixtures', () => {
    const frontendDataSource = fs.readFileSync(FRONTEND_DATA_PATH, 'utf8');
    expect(frontendDataSource).not.toMatch(/\bord:\s*\d+/);
    expect(frontendDataSource).toContain('ord: null');
    expect(frontendDataSource).toContain('WK_ORDERS: (number | null)[] = [null, null, null, null]');
  });

  it('produces identical deterministic dataset counts across repeated dry-run/replay expansions', () => {
    const baseLines = fs
      .readFileSync(path.join(SYNTHETIC_DIR, 'events/two_session_story.jsonl'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const expand = (pairCount: number) => {
      const uniqueEvents = new Map<string, Record<string, unknown>>();
      for (let idx = 1; idx <= pairCount; idx += 1) {
        const suffix = `-pair-${String(idx).padStart(3, '0')}`;
        for (const raw of baseLines) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const eventId = `${String(parsed.event_id)}${suffix}`;
          const sessionId = `${String(parsed.session_id)}${suffix}`;
          uniqueEvents.set(eventId, { ...parsed, event_id: eventId, session_id: sessionId });
        }
      }
      const sessions = new Set([...uniqueEvents.values()].map((e) => String(e.session_id)));
      return {
        uniqueEventCount: uniqueEvents.size,
        distinctSessionCount: sessions.size,
        eventIds: [...uniqueEvents.keys()],
      };
    };

    const dryRun = expand(150);
    const replay = expand(150);

    expect(dryRun.distinctSessionCount).toBe(300);
    expect(dryRun.uniqueEventCount).toBe(3150);
    expect(replay).toEqual(dryRun);
  });
});
