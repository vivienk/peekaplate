// Local workerd harness only: no container configuration, bucket, queue or provider transport.
import { ExtractionContainer, type ExtractionHostEnv } from '../src/extraction-host';

export class BudgetTest extends ExtractionContainer {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/test/fail-reservation') {
      this.ctx.storage.sql.exec(`
        CREATE TRIGGER fail_reservation BEFORE INSERT ON provider_call_reservations
        BEGIN SELECT RAISE(ABORT, 'synthetic reservation failure'); END;
      `);
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === '/test/clear-failure') {
      this.ctx.storage.sql.exec('DROP TRIGGER fail_reservation');
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname !== '/_budget/reserve')
      return new Response(null, { status: 404 });
    return super.fetch(request);
  }
}

export default {
  fetch(request: Request, env: Pick<ExtractionHostEnv, 'EXTRACTOR'>): Promise<Response> {
    // Fixed object deliberately exercises different tenant/job counters in the shared scheduler.
    return env.EXTRACTOR.getByName('synthetic-budget-test').fetch(request);
  },
};
