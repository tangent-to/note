import {defineConfig} from 'vite'
import {svelte} from '@sveltejs/vite-plugin-svelte'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte()],
  server: {
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
