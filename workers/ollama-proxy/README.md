# Ollama Cloud CORS proxy (Cloudflare Worker)

The deployed web app can't call `https://ollama.com` directly from the browser —
Ollama Cloud doesn't send CORS headers, so the browser blocks the request. This
Worker sits in front of `ollama.com`, forwards `/api/*` requests, and adds the
CORS headers the browser needs.

It does **not** store or inject API keys. Each user's Ollama key passes through
in the `Authorization` header exactly as their browser sent it, so users keep
using their own key and quota.

## Deploy

### Automatic (recommended, no local tooling)

A GitHub Action (`.github/workflows/deploy-worker.yml`) deploys this worker on
every push to `main` that touches `workers/ollama-proxy/**`. One-time setup:

1. Create a free Cloudflare API token: Cloudflare dashboard -> My Profile ->
   API Tokens -> Create Token -> use the **"Edit Cloudflare Workers"** template.
2. In GitHub: **Settings -> Secrets and variables -> Actions -> Secrets -> New
   repository secret**, name `CLOUDFLARE_API_TOKEN`, paste the token.
3. Trigger the workflow (push to `main`, or run it manually from the Actions
   tab). The run log prints the worker URL, e.g.
   `https://ollama-proxy.<account>.workers.dev`.

After the first deploy, set that URL as the `VITE_OLLAMA_PROXY_URL` repository
**Variable** (see below) so the site uses it. That's the only thing you set by
hand; everything redeploys automatically afterwards.

### Manual (alternative)

```bash
cd workers/ollama-proxy
npx wrangler login        # first time only
npx wrangler deploy
```

Either way, Wrangler/the action prints the deployed URL, e.g.
`https://ollama-proxy.<account>.workers.dev`.

CORS is locked to `https://notebook.tangent.to` by default (via `ALLOWED_ORIGIN`
in `wrangler.toml`). Change it to your own domain before deploying, or set it to
`"*"` to allow any origin (less secure).

## Point the app at it

The GitHub Pages deploy (`.github/workflows/deploy.yml`) already reads a
repository **Variable** named `VITE_OLLAMA_PROXY_URL` at build time. To turn on
hosted AI:

1. In the repo: **Settings -> Secrets and variables -> Actions -> Variables ->
   New repository variable**.
2. Name `VITE_OLLAMA_PROXY_URL`, value the worker URL with no trailing slash and
   no `/api`, e.g. `https://ollama-proxy.<account>.workers.dev`.
3. Re-run the deploy (push to `main`, or run the workflow manually).

When it's set, the deployed app routes Ollama requests through the proxy and the
in-app CORS notice disappears. When empty, the app calls `ollama.com` directly
(blocked by browser CORS on the live site). This is a Variable, not a Secret:
the worker URL is not sensitive, and no Cloudflare token is involved.

To build locally with the proxy: `VITE_OLLAMA_PROXY_URL="https://..." npm run build`.
Plain `npm run dev` doesn't need any of this — the Vite dev server proxies
`ollama.com` for you.
