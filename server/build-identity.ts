import type { BuildIdentity } from '../src/self-update-types'

declare const __POISE_BUILD_SHA__: string | null
/** Supplied by esbuild, not read from the checkout at runtime. */
export const BUILD_SHA = typeof __POISE_BUILD_SHA__ === 'string' && /^[0-9a-f]{40}$/.test(__POISE_BUILD_SHA__)
  ? __POISE_BUILD_SHA__ : null

export function buildIdentity(): BuildIdentity {
  const id = process.env.POISE_RELEASE_ID
  return { sha: BUILD_SHA, releaseId: BUILD_SHA && id && /^[A-Za-z0-9._-]{1,120}$/.test(id) ? id : null }
}
