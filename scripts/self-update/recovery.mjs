// The recovery UI. A tiny loopback HTTP server inside the controller daemon —
// independent of the main application — that shows release state and offers
// a one-click rollback to the previous release. Because it serves HTML to a
// browser it is defensive in the browser's terms: exact Host, same-origin
// POSTs only (Origin plus Fetch Metadata), a single-use nonce per rendered
// form, no scripts, a strict CSP, and every dynamic value escaped.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { ControllerError } from './controller.mjs'
import { readBody } from './control-api.mjs'
import { isReleaseId } from './paths.mjs'

export const NONCE_TTL_MS = 15 * 60_000
const MAX_FORM_BYTES = 8 * 1024

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function createNonceStore({ now = () => Date.now(), ttlMs = NONCE_TTL_MS } = {}) {
  const issued = new Map()
  return {
    issue() {
      const nonce = randomBytes(24).toString('base64url')
      issued.set(nonce, now() + ttlMs)
      if (issued.size > 500) {
        for (const [key, expires] of issued) if (expires < now()) issued.delete(key)
      }
      return nonce
    },
    consume(nonce) {
      if (typeof nonce !== 'string' || !issued.has(nonce)) return false
      const expires = issued.get(nonce)
      issued.delete(nonce)
      return expires >= now()
    },
  }
}

/** Reject anything a browser would send from another origin, or a non-browser guess at the host. */
export function assertRecoveryRequest(req, { port, allowedHosts = ['127.0.0.1', 'localhost', '[::1]'] }) {
  const host = String(req.headers.host || '').toLowerCase()
  const permitted = allowedHosts.map((name) => `${name}:${port}`)
  if (!permitted.includes(host)) throw new ControllerError(403, 'host is not allowed', 'forbidden')
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') throw new ControllerError(403, 'cross-origin requests are not allowed', 'forbidden')
  const origin = req.headers.origin
  if (origin !== undefined && String(origin).toLowerCase() !== `http://${host}`) {
    throw new ControllerError(403, 'origin is not allowed', 'forbidden')
  }
  if (req.method === 'POST') {
    if (origin === undefined && site !== 'same-origin') throw new ControllerError(403, 'POST requires a same-origin browser context', 'forbidden')
    const mode = String(req.headers['sec-fetch-mode'] || '').toLowerCase()
    if (mode && mode !== 'navigate' && mode !== 'same-origin' && mode !== 'cors') throw new ControllerError(403, 'request mode is not allowed', 'forbidden')
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/x-www-form-urlencoded') throw new ControllerError(415, 'form submissions only', 'unsupported')
  }
  return host
}

function page({ status, nonce, cspNonce, message, error }) {
  const active = status.activeRelease
  const previous = status.previousRelease
  const rollbackable = Boolean(active && previous && !status.hold && status.changes.every((change) => change.state !== 'reverting'))
  const rows = status.changes.slice(-12).reverse().map((change) => `
      <tr>
        <td><code>${escapeHtml(change.id.slice(0, 8))}</code></td>
        <td>${escapeHtml(change.title)}</td>
        <td><strong>${escapeHtml(change.state)}</strong>${change.sourceRevert ? ` <small>(source revert ${escapeHtml(change.sourceRevert.state)})</small>` : ''}</td>
        <td>${change.prUrl ? `<a href="${escapeHtml(change.prUrl)}" rel="noreferrer noopener">#${escapeHtml(change.prNumber)}</a>` : ''}</td>
        <td>${escapeHtml(change.error || '')}</td>
      </tr>`).join('')
  const release = (label, value) => `<dt>${label}</dt><dd>${value
    ? `<code>${escapeHtml(value.id)}</code> · <code>${escapeHtml(value.sha.slice(0, 12))}</code> · ${escapeHtml(value.createdAt)}<br><small>${escapeHtml(value.root)}</small>`
    : '<em>none</em>'}</dd>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Poise release recovery</title>
<style nonce="${cspNonce}">
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 2rem auto; max-width: 64rem; padding: 0 1rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.4rem; } code { font-size: 0.9em; } dt { font-weight: 600; margin-top: .75rem; } dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; } td, th { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  .notice { padding: .75rem 1rem; border-radius: .5rem; margin: 1rem 0; } .ok { background: #e6f4ea; } .bad { background: #fde8e8; } .hold { background: #fff4d6; }
  button { font: inherit; padding: .5rem 1rem; border-radius: .5rem; border: 1px solid #b00020; background: #fff; color: #b00020; cursor: pointer; }
  button:disabled { opacity: .5; cursor: not-allowed; } form { display: inline-block; margin-right: 1rem; }
</style>
</head>
<body>
<h1>Poise release recovery</h1>
<p>Served by the release controller, independent of the Poise application. Rollback needs no network, model or build: it switches the active pointer to the previous release already on disk and restarts the service.</p>
${message ? `<div class="notice ok">${escapeHtml(message)}</div>` : ''}
${error ? `<div class="notice bad">${escapeHtml(error)}</div>` : ''}
${status.hold ? `<div class="notice hold"><strong>Promotion hold:</strong> ${escapeHtml(status.hold.reason)}<br><small>change ${escapeHtml(status.hold.changeId)} · ${escapeHtml(status.hold.sha.slice(0, 12))}</small></div>` : ''}
${!status.enabled ? `<div class="notice bad">Self-update is disabled: ${escapeHtml(status.reason || 'not bootstrapped')}</div>` : ''}
<dl>
  ${release('Active release', active)}
  ${release('Previous release (rollback target)', previous)}
</dl>
<form method="post" action="/rollback">
  <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
  <input type="hidden" name="expectedReleaseId" value="${escapeHtml(active?.id || '')}">
  <button type="submit"${rollbackable ? '' : ' disabled'}>Roll back to previous release</button>
</form>
${status.hold ? `<form method="post" action="/clear-hold"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button type="submit">Clear promotion hold</button></form>` : ''}
<h2>Changes</h2>
<table>
  <thead><tr><th>Change</th><th>Title</th><th>State</th><th>PR</th><th>Error</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5"><em>no changes recorded</em></td></tr>'}</tbody>
</table>
</body>
</html>
`
}

function parseForm(text) {
  const params = new URLSearchParams(text)
  return Object.fromEntries(params.entries())
}

export function createRecoveryHandler(controller, { port, nonces = createNonceStore(), log = () => {} }) {
  async function render(res, { message = null, error = null, status: httpStatus = 200 } = {}) {
    const status = await controller.status()
    const nonce = nonces.issue()
    const cspNonce = randomBytes(16).toString('base64')
    const html = page({ status, nonce, cspNonce, message, error })
    res.writeHead(httpStatus, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'nonce-${cspNonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    })
    res.end(html)
  }

  function json(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    })
    res.end(payload)
  }

  return async (req, res) => {
    let trusted = false
    try {
      assertRecoveryRequest(req, { port })
      trusted = true
      const url = new URL(req.url || '/', 'http://recovery')
      if (req.method === 'GET' && url.pathname === '/') return await render(res)
      if (req.method === 'GET' && url.pathname === '/status.json') return json(res, 200, await controller.status())
      if (req.method === 'POST' && (url.pathname === '/rollback' || url.pathname === '/clear-hold')) {
        const form = parseForm(await readBody(req, MAX_FORM_BYTES))
        if (!nonces.consume(form.nonce)) throw new ControllerError(403, 'the form has expired; reload and try again', 'nonce')
        if (url.pathname === '/clear-hold') {
          await controller.clearHold()
          return await render(res, { message: 'Promotion hold cleared.' })
        }
        if (!isReleaseId(form.expectedReleaseId)) throw new ControllerError(400, 'expectedReleaseId is required', 'invalid')
        const result = await controller.rollbackRelease({ expectedReleaseId: form.expectedReleaseId })
        controller.kick()
        return await render(res, { message: `Rollback ${result.rollback.phase}: release ${result.rollback.expectedReleaseId} → ${result.rollback.targetReleaseId}.` })
      }
      throw new ControllerError(404, 'not found', 'not_found')
    } catch (error) {
      const status = error instanceof ControllerError ? error.status : 500
      if (!(error instanceof ControllerError)) log(`[self-update] recovery error: ${error?.stack || error}`)
      const message = error instanceof ControllerError ? error.message : 'internal error'
      if (trusted && req.method === 'POST' && status < 500) {
        try {
          return await render(res, { error: message, status })
        } catch {
          // Fall through to the plain answer.
        }
      }
      json(res, status, { error: message })
    }
  }
}

export function createRecoveryServer(controller, { host = '127.0.0.1', port, log = () => {}, nonces } = {}) {
  const server = createServer(createRecoveryHandler(controller, { port, nonces, log }))
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  return {
    server,
    url: `http://${host}:${port}/`,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host, port, exclusive: true }, () => {
          server.off('error', reject)
          resolve()
        })
      })
      log(`[self-update] recovery ui at http://${host}:${port}/`)
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
    },
  }
}
