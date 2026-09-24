import { defineConfig, loadEnv, type Plugin } from 'vite'
import { resolve } from 'node:path'
import { buildSourceSha } from './scripts/build-identity.mjs'
import { validateConfabUrl } from './server/runtime-config'

// Used only by the development server, never a client-side define.
const RUNTIME_ENV_KEYS = [
  'JEV_API_KEY',
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
      // Development must never share production's durable state. A second
      // Vite process used to reconcile and mutate ~/.poise/cache.db while the
      // launchd service was live.
      process.env.POISE_DB = process.env.POISE_DEV_DB
        || env.POISE_DEV_DB
        || resolve(process.cwd(), '.poise-dev/cache.db')
      // Keep database and filesystem initialization out of config loading and
      // production builds. The API runtime is loaded only when Vite serves.
      for (const key of RUNTIME_ENV_KEYS) {
        if (env[key] && process.env[key] === undefined) process.env[key] = env[key]
      }
      const { attachChatSockets, createPoiseMiddleware, stopPoiseRuntime } = await import('./server/cache-plugin')
      server.middlewares.use(createPoiseMiddleware({
        reviewAgentUsername: env.REVIEW_AGENT_USERNAME || '',
        instanceLabel: 'dev',
      }))
      // Chat's WebSocket shares the dev server; Vite's own HMR socket is
      // untouched because only /ws/chat upgrades are claimed.
      if (server.httpServer) attachChatSockets(server.httpServer as import('node:http').Server)
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
    define: { __POISE_BUILD_SHA__: JSON.stringify(buildSourceSha()) },
    build: {
      outDir: 'dist/client',
    },
    optimizeDeps: {
      exclude: ['better-sqlite3'],
    },
    server: {
      // Production binds 127.0.0.1. Binding the same address makes strictPort
      // reject an accidental dev server instead of hiding it on IPv6.
      host: '127.0.0.1',
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
