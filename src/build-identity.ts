declare const __POISE_BUILD_SHA__: string | null

/** The identity of the assets actually loaded in this tab. A development or
 * uncommitted build must never participate in production auto-refresh. */
export const BUILD_SHA = typeof __POISE_BUILD_SHA__ === 'string' && /^[0-9a-f]{40}$/.test(__POISE_BUILD_SHA__)
  ? __POISE_BUILD_SHA__ : null
