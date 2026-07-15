import { defineConfig, loadEnv, type Plugin } from 'vite'
import { validateConfabUrl } from './server/runtime-config'

const RUNTIME_ENV_KEYS = [
  'AGENT_INTERFACE_ROOT',
  'POISE_CHAT_ATTACHMENTS_DIR',
  'POISE_DB',
  'POISE_EDITOR_DIR',
  'POISE_ESPANSO_MATCH_DIR',
  'POISE_VOICE_GUIDE_PATH',
] as const

function poiseApiPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'poise-api-loader',
    async configureServer(server) {
      // Keep database and filesystem initialization out of config loading and
      // production builds. The API runtime is loaded only when Vite serves.
      for (const key of RUNTIME_ENV_KEYS) {
        if (env[key] && process.env[key] === undefined) process.env[key] = env[key]
      }
      const { createPoiseMiddleware, stopPoiseRuntime } = await import('./server/cache-plugin')
      server.middlewares.use(createPoiseMiddleware({
        reviewAgentUsername: env.REVIEW_AGENT_USERNAME || '',
      }))
      server.httpServer?.once('close', () => { void stopPoiseRuntime() })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const confabUrl = validateConfabUrl(env.CONFAB_URL || 'http://localhost:8000')
  const confabKey = env.CONFAB_API_KEY || ''

  return {
    plugins: [poiseApiPlugin(env)],
    build: {
      outDir: 'dist/client',
    },
    optimizeDeps: {
      exclude: ['better-sqlite3'],
    },
    server: {
      port: 5555,
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
