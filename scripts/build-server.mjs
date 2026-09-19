import { build } from 'esbuild'
import { buildSourceSha } from './build-identity.mjs'

await build({
  entryPoints: ['server/production.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/server.js',
  define: { __POISE_BUILD_SHA__: JSON.stringify(buildSourceSha()) },
  logLevel: 'info',
})
