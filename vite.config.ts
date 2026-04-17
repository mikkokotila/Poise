import { defineConfig, loadEnv } from 'vite'
import { cachePlugin } from './server/cache-plugin'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const confabUrl = env.CONFAB_URL || 'http://localhost:8000'
  const confabKey = env.CONFAB_API_KEY || ''

  return {
    plugins: [cachePlugin()],
    optimizeDeps: {
      exclude: ['better-sqlite3'],
    },
    server: {
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
