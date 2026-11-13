// Vite development middleware only. Never put these credentials in VITE_*.
export function localModelProxy({ token, fetchImpl = fetch, port = 5173, apiPort = 5182 }) {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/__local3d/')) return next();
    const reply = (status, error) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error }));
    };
    const host = req.headers.host;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return reply(403, 'local_only');
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      return reply(403, 'same_origin_required');
    }
    const path = req.url.slice('/__local3d'.length);
    const id = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const get =
      req.method === 'GET' &&
      (path === '/health' ||
        new RegExp(
          `^/v1/model-jobs/${id}(/artifacts/(source\\.png|fallback\\.jpg|model\\.glb))?$`,
        ).test(path));
    const upload =
      req.method === 'POST' && new RegExp(`^/v1/portion-uploads/${id}/${id}$`).test(path);
    const post =
      req.method === 'POST' &&
      (upload ||
        path === '/v1/model-jobs' ||
        new RegExp(`^/v1/model-jobs/${id}/resume$`).test(path));
    if (!get && !post) return reply(404, 'route_unavailable');
    if (post && origin !== `http://${host}`) return reply(403, 'same_origin_required');
    if (!token) return reply(503, 'local_service_not_configured');
    try {
      let length = 0;
      const chunks = [];
      if (post) {
        for await (const chunk of req) {
          length += chunk.length;
          if (length > (upload ? 12_000_000 : 8192)) return reply(413, 'request_too_large');
          chunks.push(chunk);
        }
      }
      const upstream = await fetchImpl(`http://127.0.0.1:${apiPort}${path}`, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': upload ? 'application/octet-stream' : 'application/json',
        },
        body: post ? Buffer.concat(chunks) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(upload ? 200_000 : 35_000),
      });
      const reader = upstream.body?.getReader();
      const parts = [];
      let bytes = 0;
      if (reader) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > (path.endsWith('/model.glb') ? 50_000_000 : 10_000_000)) {
              throw new Error('Response exceeds local budget');
            }
            parts.push(value);
          }
        } finally {
          await reader.cancel();
        }
      }
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(Buffer.concat(parts));
    } catch {
      reply(502, 'local_service_unavailable');
    }
  };
}

export function localModelPlugin() {
  return {
    name: 'peekaplate-local-model-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(
        localModelProxy({
          token: process.env.TRIPO_SERVICE_TOKEN,
          port: Number(process.env.PORTION_DEMO_PORT || 5173),
          apiPort: Number(process.env.PORTION_API_PORT || 5182),
        }),
      );
    },
  };
}
