import type { PreparedMenu } from '@peekaplate/contracts';
import { fetchPreparedMenu } from './owner-publication';

// Local runtime regression harness only; no external requests or credentials.
export default {
  async fetch(request: Request) {
    const fixture = (await request.json()) as {
      menu: PreparedMenu;
      bytes: string;
      redirect: boolean;
    };
    let requests = 0;
    try {
      const content = await fetchPreparedMenu(fixture.menu, async (input, init) => {
        requests++;
        const outbound = new Request(input, init);
        if (outbound.redirect !== 'manual') throw new Error('Redirects must stay manual');
        return fixture.redirect
          ? new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/' } })
          : new Response(fixture.bytes);
      });
      return Response.json(content, { headers: { 'X-Fixture-Requests': String(requests) } });
    } catch {
      return new Response(null, {
        status: 502,
        headers: { 'X-Fixture-Requests': String(requests) },
      });
    }
  },
};
