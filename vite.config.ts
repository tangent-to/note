import {defineConfig} from 'vite'
import {svelte} from '@sveltejs/vite-plugin-svelte'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte()],
  preview: {
    // Same reasoning as `server.port` below: a stable origin keeps stored
    // settings and autosaves attached to the app.
    port: 4173,
    strictPort: true,
  },
  server: {
    // Pin the port. Browser storage is scoped to the origin *including the
    // port*, so when Vite silently moved to 5174 because 5173 was busy, every
    // saved setting (kernel, theme, reactive mode, panel width) and the
    // autosaved notebook appeared to have been forgotten. Failing to start is
    // the lesser surprise.
    port: 5173,
    strictPort: true,
    // Proxy Ollama Cloud through the dev server so the browser never makes a
    // cross-origin request during local development (avoids CORS). The app
    // points at `/ollama/api` in dev (see defaultBaseUrl in aiService.ts).
    proxy: {
      '/ollama': {
        target: 'https://ollama.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, '')
      }
    },
    // Use polling for file watching to avoid ENOSPC "watchers" errors on
    // systems with a low inotify watch limit (common on some Linux setups).
    // Polling is slightly less efficient but reliable for dev environments.
    watch: {
      usePolling: true,
      // Poll every 100ms (adjust if needed)
      interval: 100
    }
  }
})
