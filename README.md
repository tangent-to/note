# tangent/note

A (mostly, sorry) vibe coded javascript notebook, featuring a modern sober interface, supporting data viz, local-first on the web, with a Zed/deno -style notebook format in pure JavaScript.

## Start

### Prerequisites

- Node.js 20+

### Installation

```bash
# Clone the repository
git clone https://github.com/tangent-to/note.git
cd notebook

# Install dependencies
npm install
```

### Running

```bash
npm run dev
# then head to http://localhost:5173
```

**Build for Production:**

```bash
npm run build
```

## Usage

### Open a notebook from a link

A notebook can be opened directly from a URL — handy for sharing:

- **From any URL:** `https://note.tangent.to/import?url=https://example.com/my-notebook.js`
  (a pasted `github.com/...blob...` URL is rewritten to its raw form automatically)
- **From GitHub:** `https://note.tangent.to/gh/<owner>/<repo>/<path-to-file>.js`
  (uses the repo's default branch; pin one with `/gh/<owner>/<repo>@<ref>/<path>`)

Both `.js` (Tangent notebook format, see [NOTEBOOK_FORMAT.md](NOTEBOOK_FORMAT.md))
and `.json` exports work. The host serving the file must allow cross-origin
requests (GitHub raw content does). Nothing runs automatically — you still
choose when to run cells.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + K` | Open Command Palette |
| `Ctrl/Cmd + /` | Toggle AI Chat |
| `Ctrl/Cmd + S` | Save Notebook |
| `Ctrl/Cmd + N` | New Notebook |
| `Ctrl/Cmd + O` | Open Notebook |
| `Ctrl/Cmd + Enter` | Run Current Cell |
| `Shift + Enter` | Run Cell and Select Next |
| `Alt + Enter` | Run Cell and Insert Below |

### AI Setup

The AI assistant is powered by **Ollama Cloud**. Open the AI sidebar
(`Ctrl/Cmd + /`), click the settings icon, and paste your API key (from
[ollama.com/settings/keys](https://ollama.com/settings/keys)). The current
notebook is automatically sent to the model as context (as a system prompt), so
you can ask it to explain, extend, or debug your cells.

Default model: `qwen3-coder:480b-cloud` (any Ollama Cloud model works, e.g.
`gpt-oss:120b-cloud`).

#### CORS and the browser

Ollama Cloud doesn't send CORS headers, so a browser can't call it directly.
This project handles that with a small proxy — no browser extensions needed:

- **Running locally (`npm run dev`)** — works out of the box. The Vite dev
  server proxies requests to `ollama.com`, so there's nothing to configure.
- **Deployed web build (e.g. note.tangent.to)** — deploy the bundled
  **Cloudflare Worker** proxy once and point the app at it. The worker forwards
  requests to `ollama.com` and adds CORS headers; each user still uses their own
  API key (it just passes through — the worker never stores it). See
  [`workers/ollama-proxy/README.md`](workers/ollama-proxy/README.md), then build
  with `VITE_OLLAMA_PROXY_URL` set to the worker URL. Without it configured, the
  app shows a notice and AI calls will be blocked by the browser.

### Examples

Head to note.tangent.to

## Tech stack

- **Frontend**. Svelte, TypeScript, Tailwind CSS
- **Build Tool**. Vite
- **Editor**. Monaco Editor
- **AI**. Ollama Cloud
- **Viz Libraries**. Observable Plot, Plotly, D3.js, Vega-Lite, Arquero

## File Format

Notebooks use a git-friendly text format (`.js` extension):

```javascript
// ---
// title: My Notebook
// id: notebook-12345
// ---

// %% [markdown]
/*
# Welcome to Tangent Notebooks
*/

// %% [javascript]
const data = [1, 2, 3, 4, 5];
console.log(data);
```

See [NOTEBOOK_FORMAT.md](NOTEBOOK_FORMAT.md) for details.

## License

MIT License - see [LICENSE](LICENSE) file for details.
