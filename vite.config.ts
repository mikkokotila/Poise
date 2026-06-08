import { defineConfig, loadEnv } from 'vite'
import { cachePlugin } from './server/cache-plugin'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const confabUrl = env.CONFAB_URL || 'http://localhost:8000'
  const confabKey = env.CONFAB_API_KEY || ''

  return {
    plugins: [cachePlugin({
      reviewAgentUsername: env.REVIEW_AGENT_USERNAME || '',
    })],
    optimizeDeps: {
      exclude: ['better-sqlite3'],
    },
    server: {
      // Bind exactly 5173 or fail loudly — never drift. Vite's default
      // is to silently hop to 5174, 5175… when 5173 is busy; combined
      // with the `poise` launcher always opening :5173, that means the
      // browser lands on whatever stale server holds 5173 while the real
      // server runs on a port nobody opened. strictPort makes that
      // impossible: the dev server is on 5173 or it exits with an error.
      port: 5173,
      strictPort: true,
      proxy: {
        // Note: /api/github/* is NOT proxied here — it's handled by cachePlugin
        // middleware so the token can come from the SQLite meta table.
        '/api/confab': {
          target: confabUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/confab/, '/api'),
          configure: (proxy) => {
            if (confabKey) {
              proxy.on('proxyReq', (proxyReq) => {
                proxyReq.setHeader('Authorization', `Bearer ${confabKey}`)
              })
            }
          },
        },
      },
    },
  }
})
