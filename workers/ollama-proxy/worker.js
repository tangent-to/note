// Cloudflare Worker: CORS proxy for Ollama Cloud.
//
// The deployed web app (e.g. notebook.tangent.to) cannot call https://ollama.com
// directly from the browser because Ollama Cloud does not send CORS headers.
// This Worker sits in front of ollama.com, forwards `/api/*` requests, and adds
// the CORS headers the browser needs.
//
// It does NOT store or inject API keys: each user's Ollama key travels through
// in the Authorization header exactly as the browser sent it. The Worker only
// proxies the Ollama API surface, so it cannot be used as a generic open relay.
//
// Binding (wrangler.toml [vars]):
//   ALLOWED_ORIGIN  Origin allowed by CORS. Set to "https://notebook.tangent.to"
//                   in wrangler.toml by default; use "*" to allow any origin.
//                   Falls back to "*" if the binding is removed entirely.

const UPSTREAM = 'https://ollama.com';

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const requestOrigin = request.headers.get('Origin') || '';
    const allowOrigin =
      allowed === '*' ? '*' : requestOrigin === allowed ? allowed : allowed;

    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // Only proxy the Ollama API surface.
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404, headers: cors });
    }

    // Rebuild a clean upstream request: forward only the headers we need.
    const headers = new Headers();
    headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
    const auth = request.headers.get('Authorization');
    if (auth) headers.set('Authorization', auth);

    const init = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.text();
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + url.pathname + url.search, init);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Upstream request failed', detail: String(err) }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    const respHeaders = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(cors)) respHeaders.set(key, value);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};
