# Ollama Cloud CORS proxy (Cloudflare Worker)

The deployed web app can't call `https://ollama.com` directly from the browser —
Ollama Cloud doesn't send CORS headers, so the browser blocks the request. This
Worker sits in front of `ollama.com`, forwards `/api/*` requests, and adds the
CORS headers the browser needs.

It does **not** store or inject API keys. Each user's Ollama key passes through
in the `Authorization` header exactly as their browser sent it, so users keep
using their own key and quota.

## Deploy

```bash
cd workers/ollama-proxy
npx wrangler login        # first time only
npx wrangler deploy
```

Wrangler prints the deployed URL, e.g. `https://ollama-proxy.<account>.workers.dev`
(or a custom domain you configure in the Cloudflare dashboard).

Optionally lock CORS to your site by uncommenting `ALLOWED_ORIGIN` in
`wrangler.toml` before deploying.

## Point the app at it

Set the proxy URL when building the web app (no trailing slash, no `/api`):

```bash
VITE_OLLAMA_PROXY_URL="https://ollama-proxy.<account>.workers.dev" npm run build
```

In CI (GitHub Actions), add `VITE_OLLAMA_PROXY_URL` as a build environment
variable. When it's set, the deployed app sends Ollama requests through the
proxy and the in-app CORS notice disappears — it "just works" with no browser
extension required.

Local development (`npm run dev`) doesn't need this: the Vite dev server already
proxies `ollama.com` for you.
