# tangent/notebook

A (mostly, sorry) vibe coded javascript notebook, featuring a modern sober interface, supporting data viz, local-first on the web, with a Zed/deno -style notebook format in pure JavaScript.

## Start

### Prerequisites

- Node.js 20+

### Installation

```bash
# Clone the repository
git clone https://github.com/tangent-to/tangent-notebook.git
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

Ollama Cloud is called directly from your browser, and browsers block such
cross-origin requests by default (CORS):

- **Running locally (`npm run dev`)** — works out of the box. The dev server
  proxies requests to `ollama.com`, so there's nothing to configure.
- **Deployed web build (e.g. notebook.tangent.to)** — the app will detect this
  and show a notice. To make it work you need to relax CORS in your browser:
  - **Chrome / Firefox**: install a CORS-unblock extension (e.g. "CORS Unblock"
    or "Allow CORS") and enable it for the site.
  - **Safari**: enable the Develop menu, then check
    *Develop → Disable Cross-Origin Restrictions*.

  Only enable these while using the app — leaving CORS disabled globally is a
  security risk.

### Examples

Head to notebook.tangent.to

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
