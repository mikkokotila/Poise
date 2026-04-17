import { defineConfig, loadEnv } from 'vite'
import { execSync } from 'child_process'
import { cachePlugin } from './server/cache-plugin'

function getGitHubToken(): string {
  try {
    return execSync('gh auth token', { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

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
        '/api/github': {
          target: 'https://api.github.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/github/, ''),
          configure: (proxy) => {
            const token = getGitHubToken()
            if (token) {
              proxy.on('proxyReq', (proxyReq) => {
                proxyReq.setHeader('Authorization', `Bearer ${token}`)
                proxyReq.setHeader('User-Agent', 'poise')
              })
            }
          },
        },
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
