import { jevApi, JevHttpError } from '../jev-client'
import { emptyJevDraft, exampleJevDraft, parseJevDraft, requestFromDraft, draftFromRequest, type JevDraft } from '../jev-draft'
import { validateJevRequest, type JevSession, type JevRun, type JevRequest } from '../jev-types'
import { createJevBuilder } from './jev-builder'
import { renderJevRun } from './jev-results'
import { escapeHtml as esc } from '../markdown'
import { ICON_MEMORIES } from './chat-icons'
import { registerReloadGuard } from '../self-update-watch'

const ACTIVE = 'poise-jev-active'
const LOCAL = 'poise-jev-draft:'
interface Entry { session: JevSession; draft: JevDraft; title: string; dirty: boolean; saving?: Promise<void>; error?: string; conflict?: boolean; created: boolean; deleting?: boolean; pendingId?: string; pendingRequest?: JevRequest; creation?: { id: string; title: string; draft: string } }
interface Handlers { activate(id: string): void; close(): void; memories(): void; flushMemories(): Promise<void> }
export function createJevWorkspace(parent: HTMLElement, sidebar: HTMLElement, handlers: Handlers) {
  const el = document.createElement('section'); el.className = 'jev-workspace'; el.hidden = true
  el.setAttribute('aria-label', 'JEV primitive builder')
  el.innerHTML = `<header class="jev-header"><span class="chat-pill">JEV · primitives</span><input class="jev-title" aria-label="Workspace title" maxlength="200" value="Untitled primitives"><button type="button" class="chat-icon-btn jev-memories" aria-label="Memories" data-tooltip="Memories">${ICON_MEMORIES}</button><button type="button" class="st-clear jev-back">Back to chat</button><button type="button" class="st-clear jev-delete">Delete</button></header>
    <div class="jev-scroll"><div class="jev-intro"><h2>State in. Typed answers out.</h2><p>Build focused judgments, not a conversation. Run one question or many together.</p></div>
      <div class="jev-notice st-help" role="status" hidden></div><div class="jev-conflict" hidden><button type="button" class="st-clear" data-recovery="reload">Reload saved</button><button type="button" class="st-clear" data-recovery="keep">Save my version</button></div>
      <section class="jev-run-view" hidden><div class="jev-section-heading"><h3>Results</h3><select class="st-select jev-run-select" aria-label="Evaluation history"></select><button type="button" class="st-clear jev-older" hidden>Earlier runs</button></div><div class="jev-result"></div><div class="jev-result-actions"><button type="button" class="st-clear" data-result="copy">Copy result JSON</button><button type="button" class="st-clear" data-result="edit">Edit this run</button><button type="button" class="st-clear" data-result="state">Use answers as state</button></div><details class="jev-run-json"><summary>Exact request & response</summary><pre></pre></details></section>
      <div class="jev-builder-mount"></div><details class="jev-request-preview" hidden open><summary>Exact outbound request · includes saved Memories</summary><pre></pre><button type="button" class="st-clear jev-copy-request">Copy request JSON</button></details>
      <div class="jev-template" hidden><label class="jev-field">Snippet<select class="st-select" aria-label="Primitive template"></select></label><button type="button" class="st-clear jev-use-template">Load as new builder</button><button type="button" class="st-clear jev-close-template">Close</button><label class="jev-field">Save this request as a snippet<input class="st-input jev-template-name" aria-label="Template name" placeholder=";my-primitive"></label><button type="button" class="st-clear jev-save-template">Save template</button><p class="st-help">Save request JSON as a snippet to reuse your questions. Ordinary text skills are not primitive definitions.</p></div>
    </div><footer class="jev-footer"><div><span class="jev-save-status" role="status"></span><button type="button" class="st-clear jev-retry-save" hidden>Retry save</button><button type="button" class="st-clear jev-pending" hidden>Check pending run</button><button type="button" class="st-clear jev-resubmit" hidden>Retry submission</button><div class="st-help">Shared Memories, when set, are included last in each question. No chat history.</div><div class="jev-validation st-help" role="status"></div></div><button type="button" class="st-clear jev-cancel" hidden>Stop</button><button type="button" class="st-save jev-evaluate">Evaluate</button></footer>`
  parent.append(el)
  const list = document.createElement('div'); list.className = 'jev-session-list'; list.setAttribute('role', 'list'); list.hidden = true; sidebar.prepend(list)
  const entries = new Map<string, Entry>()
  let pollingPaused = false
  let active: string | null = null, visible = false, configured = false, initialized = false, navigation = 0
  let submitting = false, saveTimer: ReturnType<typeof setTimeout> | undefined, pollTimer: ReturnType<typeof setTimeout> | undefined
  let runLoadGeneration = 0
  let runs: JevRun[] = [], selectedRun = '', nextPage: number | undefined, preview: JevRequest | null = null, localSafe = true
  const title = el.querySelector<HTMLInputElement>('.jev-title')!
  const notice = el.querySelector<HTMLElement>('.jev-notice')!
  const runButton = el.querySelector<HTMLButtonElement>('.jev-evaluate')!
  const cancelButton = el.querySelector<HTMLButtonElement>('.jev-cancel')!
  const builder = createJevBuilder({ models: async () => (await jevApi<{ models: Array<{ name: string; description: string }> }>('models')).models, changed(value) { const e = current(); if (!e) return; e.draft = value; preview = null; el.querySelector<HTMLElement>('.jev-request-preview')!.hidden = true; e.dirty = true; e.error = undefined; persist(e); scheduleSave(e); controls() }, evaluate: () => { void evaluate() }, preview: () => { void showPreview() }, example, template: () => { void showTemplates() } })
  el.querySelector('.jev-builder-mount')!.append(builder.el)
  function example() {
    const e = current()
    if (!e || JSON.stringify(e.draft) !== JSON.stringify(emptyJevDraft())) { void create(exampleJevDraft()); return }
    e.draft = exampleJevDraft(); e.title = 'Example · customer triage'; e.dirty = true
    title.value = e.title; builder.set(e.draft); persist(e); void save(e); controls()
  }
  function current() { return active ? entries.get(active) : undefined }
  function message(text: string, error = false) { notice.hidden = !text; notice.textContent = text; notice.classList.toggle('st-help-error', error) }
  function persist(e: Entry) {
    try { const text = JSON.stringify({ draft: e.draft, title: e.title, revision: e.session.revision, dirty: e.dirty, pendingId: e.pendingId, pendingRequest: e.pendingRequest, creation: e.creation }); sessionStorage.setItem(LOCAL + e.session.id, text); localSafe = sessionStorage.getItem(LOCAL + e.session.id) === text }
    catch { localSafe = false }
  }
  function accept(session: JevSession): Entry {
    const existing = entries.get(session.id)
    if (existing) return existing
    const e: Entry = { session, draft: parseJevDraft(session.draft), title: session.title, dirty: false, created: true }
    try {
      const raw = sessionStorage.getItem(LOCAL + session.id)
      if (raw) { const saved = JSON.parse(raw); e.pendingId = saved.pendingId; e.pendingRequest = saved.pendingRequest; e.creation = saved.creation; if (saved.dirty) { e.draft = parseJevDraft(JSON.stringify(saved.draft)); e.title = saved.title; e.dirty = true; e.conflict = saved.revision !== session.revision; if (e.conflict) e.error = 'The server has a newer draft. Your unsaved local version is preserved.' } }
    } catch { e.error = 'A local draft could not be restored. The server’s saved builder is shown.' }
    if (JSON.stringify(e.draft) === session.draft && e.title === session.title) { e.dirty = false; e.conflict = false; e.error = undefined }
    entries.set(session.id, e); return e
  }
  function renderList() {
    list.hidden = entries.size === 0
    list.innerHTML = [...entries.values()].sort((a, b) => b.session.createdAt.localeCompare(a.session.createdAt)).map(e => `<div role="listitem"><button type="button" class="jev-session-item ${visible && e.session.id === active ? 'active' : ''}" data-jev-id="${esc(e.session.id)}"><span>${esc(e.title)}</span><small>JEV · primitives</small></button></div>`).join('')
  }
  function controls() {
    const e = current(); if (!e) return
    let invalid = ''
    try { requestFromDraft(e.draft) } catch (err) { invalid = (err as Error).message }
    const running = runs.find(run => run.status === 'running')
    el.querySelector<HTMLButtonElement>('.jev-delete')!.disabled = !!running || submitting
    el.querySelector<HTMLElement>('.jev-retry-save')!.hidden = !e.error || !!e.conflict
    el.querySelector<HTMLElement>('.jev-pending')!.hidden = !e.pendingId
    el.querySelector<HTMLElement>('.jev-resubmit')!.hidden = !e.pendingId || !e.pendingRequest
    el.querySelector<HTMLButtonElement>('.jev-resubmit')!.disabled = submitting
    runButton.disabled = submitting || !!running || !!e.pendingId || !!invalid || !configured
    runButton.textContent = submitting ? 'Starting…' : running ? 'Evaluating…' : `Evaluate${e.draft.questions.length > 1 && e.draft.raw === null ? ` ${e.draft.questions.length} questions` : ''}`
    cancelButton.hidden = !running; cancelButton.dataset.run = running?.id || ''
    el.querySelector<HTMLElement>('.jev-validation')!.textContent = !configured ? 'Set JEV_API_KEY in the server .env, then restart Poise. The builder works without a key; evaluation requires it.' : invalid || '⌘ / Ctrl + Enter to evaluate. Enter adds a line.'
    el.querySelector<HTMLElement>('.jev-save-status')!.textContent = e.error ? e.error : e.saving ? 'Saving builder…' : e.dirty ? 'Draft saved in this tab' : 'Builder saved'
    el.querySelector<HTMLElement>('.jev-conflict')!.hidden = !e.conflict
  }
  function scheduleSave(e: Entry) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void save(e) }, 500) }
  function save(e: Entry): Promise<void> {
    if (entries.get(e.session.id) !== e || e.deleting) return Promise.resolve()
    if (e.saving) return e.saving
    if (!e.dirty || e.conflict) return Promise.resolve()
    const task = (async () => {
      try {
        while (e.dirty && !e.deleting && entries.get(e.session.id) === e) {
          const text = JSON.stringify(e.draft), title = e.title.trim() || 'Untitled primitives'
          if (!e.created) e.creation ??= { id: e.session.id, title, draft: text }
          persist(e)
          const response = e.created ? await jevApi<{ session: JevSession }>(`sessions/${e.session.id}`, 'PATCH', { revision: e.session.revision, title, draft: text }) : await jevApi<{ session: JevSession }>('sessions', 'POST', e.creation)
          if (response.session.id !== e.session.id) throw new Error('The server acknowledged a different workspace; your draft is kept.')
          e.session = response.session; e.created = true; e.creation = undefined; e.error = undefined
          e.dirty = response.session.draft !== JSON.stringify(e.draft) || response.session.title !== (e.title.trim() || 'Untitled primitives')
          persist(e)
        }
      } catch (error) { e.error = (error as Error).message; e.conflict = error instanceof JevHttpError && error.status === 409; persist(e) }
    })().finally(() => { e.saving = undefined; renderList(); if (current() === e) controls() })
    e.saving = task; controls(); return task
  }
  async function create(seed = emptyJevDraft()) {
    const session: JevSession = { id: crypto.randomUUID(), title: 'Untitled primitives', revision: 0, draft: JSON.stringify(seed), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const e: Entry = { session, title: session.title, draft: seed, dirty: true, created: false }
    entries.set(session.id, e); persist(e); activate(session.id)
    await save(e)
    if (current() === e && e.created) await loadRuns()
  }
  function activate(sessionId: string) {
    const previous = current(); if (previous?.dirty) void save(previous)
    const e = entries.get(sessionId); if (!e) return
    navigation++; active = sessionId; visible = true; el.hidden = false
    el.querySelector<HTMLElement>('.jev-template')!.hidden = true
    el.querySelector<HTMLElement>('.jev-scroll')!.scrollTop = 0
    try { sessionStorage.setItem(ACTIVE, sessionId) } catch { /* optional selection */ }
    handlers.activate(sessionId); title.value = e.title; builder.set(e.draft)
    runs = []; selectedRun = ''; nextPage = undefined; preview = null
    el.querySelector<HTMLElement>('.jev-request-preview')!.hidden = true
    message(e.error || ''); renderRuns(); renderList(); controls()
    if (e.created) void loadRuns()
  }
  function leave() {
    const e = current(); if (e?.dirty) void save(e)
    navigation++; visible = false; el.hidden = true; clearTimeout(pollTimer)
    try { sessionStorage.removeItem(ACTIVE) } catch { /* optional selection */ }
    renderList()
  }
  async function loadRuns(earlier = false) {
    const origin = active, generation = navigation, requestGeneration = ++runLoadGeneration
    if (!origin) return
    try {
      const response = await jevApi<{ runs: JevRun[]; next?: number }>(`sessions/${origin}/runs${earlier && nextPage ? `?before=${nextPage}` : ''}`)
      if (active !== origin || generation !== navigation || requestGeneration !== runLoadGeneration) return
      runs = earlier ? [...runs, ...response.runs.filter(run => !runs.some(old => old.id === run.id))] : [...response.runs, ...runs.filter(run => !response.runs.some(newer => newer.id === run.id))]
      if (earlier || runs.length <= 20) nextPage = response.next
      if (!selectedRun || !runs.some(run => run.id === selectedRun)) selectedRun = runs[0]?.id || ''
      const e = current()!
      if (e.pendingId && runs.some(run => run.id === e.pendingId)) { selectedRun = e.pendingId; e.pendingId = undefined; e.pendingRequest = undefined; persist(e) }
      renderRuns(); controls()
    } catch (error) { if (active === origin && generation === navigation && requestGeneration === runLoadGeneration) message((error as Error).message, true) }
    finally { if (active === origin && generation === navigation && requestGeneration === runLoadGeneration && visible && !pollingPaused) { clearTimeout(pollTimer); pollTimer = setTimeout(() => { if (!document.hidden) void loadRuns(); else pollTimer = setTimeout(() => { void loadRuns() }, 2000) }, runs.some(run => run.status === 'running') ? 800 : 5000) } }
  }
  let resultsFingerprint = ''
  function renderRuns() {
    const fingerprint = JSON.stringify({ runs, selectedRun })
    if (fingerprint === resultsFingerprint) return
    resultsFingerprint = fingerprint
    const panel = el.querySelector<HTMLElement>('.jev-run-view')!
    panel.hidden = !runs.length
    const select = panel.querySelector<HTMLSelectElement>('.jev-run-select')!
    select.innerHTML = runs.map(run => `<option value="${run.id}" ${run.id === selectedRun ? 'selected' : ''}>${esc(new Date(run.startedAt).toLocaleTimeString())} · ${Object.keys(run.request.questions).length} questions · ${run.status}</option>`).join('')
    const run = runs.find(run => run.id === selectedRun)
    panel.querySelector<HTMLElement>('.jev-result')!.innerHTML = run ? renderJevRun(run) : ''
    panel.querySelector<HTMLElement>('.jev-run-json pre')!.textContent = run ? JSON.stringify({ request: run.request, response: run.result || null }, null, 2) : ''
    panel.querySelector<HTMLElement>('.jev-older')!.hidden = !nextPage
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-result]')) button.disabled = !run || (button.dataset.result !== 'edit' && !run.result)
  }
  async function evaluate() {
    const e = current(); if (!e || !configured || submitting || e.pendingId || runs.some(run => run.status === 'running')) return
    let request: JevRequest
    try { request = requestFromDraft(e.draft) } catch (error) { builder.error((error as Error).message); return }
    submitting = true; controls(); message('')
    try {
      await handlers.flushMemories()
      await save(e)
      if (!e.created || e.dirty || e.error) throw new Error(e.error || 'Could not save the workspace.')
      e.pendingId = crypto.randomUUID(); e.pendingRequest = request; persist(e)
      const { run } = await jevApi<{ run: JevRun }>(`sessions/${e.session.id}/runs`, 'POST', { id: e.pendingId, request })
      if (run.id !== e.pendingId || run.sessionId !== e.session.id) throw new Error('The evaluation receipt did not match this request. Check pending run before trying again.')
      e.pendingId = undefined; e.pendingRequest = undefined; persist(e)
      if (current() === e && visible) { runs.unshift(run); selectedRun = run.id; renderRuns(); void loadRuns() }
    } catch (error) {
      if (error instanceof JevHttpError && [400, 401, 403, 404, 409, 413, 422, 503].includes(error.status)) { e.pendingId = undefined; e.pendingRequest = undefined; persist(e) }
      if (current() === e) { message((error as Error).message, true); if (e.pendingId) void reconcilePending(e) }
    } finally { submitting = false; controls() }
  }
  async function reconcilePending(e: Entry) {
    if (!e.pendingId) return
    try {
      const { run } = await jevApi<{ run: JevRun }>(`runs/${e.pendingId}`)
      if (run.id !== e.pendingId || run.sessionId !== e.session.id) throw new Error('The evaluation receipt does not match this workspace.')
      e.pendingId = undefined; e.pendingRequest = undefined; persist(e)
      if (current() === e) { selectedRun = run.id; await loadRuns() }
    } catch (error) {
      if (current() === e) message('The evaluation is not confirmed yet. Check again, or Retry submission using the same request ID. Your builder is preserved.', true)
    } finally { controls() }
  }
  async function showPreview() {
    const e = current(); if (!e) return
    try {
      const request = requestFromDraft(e.draft), snapshot = JSON.stringify(e.draft)
      await handlers.flushMemories()
      const response = await jevApi<{ request: JevRequest }>('preview', 'POST', request)
      if (current() !== e || JSON.stringify(e.draft) !== snapshot) return
      preview = response.request
      el.querySelector<HTMLElement>('.jev-request-preview')!.hidden = false
      el.querySelector<HTMLElement>('.jev-request-preview pre')!.textContent = JSON.stringify(preview, null, 2)
    } catch (error) { if (current() === e) message((error as Error).message, true) }
  }
  async function copy(value: unknown) { try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); message('Copied JSON.') } catch { message('Clipboard unavailable. Select and copy the JSON shown below.', true) } }
  let templates: { trigger: string; replace: string }[] = []
  async function showTemplates() {
    const origin = active, generation = navigation
    try {
      const response = await fetch('/api/snippets', { signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error('Could not load snippets.')
      const data = await response.json()
      if (active !== origin || navigation !== generation || !visible) return
      templates = (data.snippets || []).filter((s: { replace: string }) => { try { validateJevRequest(JSON.parse(s.replace)); return true } catch { return false } })
      el.querySelector<HTMLElement>('.jev-template')!.hidden = false
      el.querySelector<HTMLSelectElement>('.jev-template select')!.innerHTML = templates.map((s, i) => `<option value="${i}">${esc(s.trigger)}</option>`).join('') || '<option>No primitive templates saved yet</option>'

      el.querySelector<HTMLButtonElement>('.jev-use-template')!.disabled = templates.length === 0
    } catch (error) { message((error as Error).message, true) }
  }
  title.addEventListener('input', () => {
    const e = current(); if (!e) return
    e.title = title.value; e.dirty = true; persist(e); scheduleSave(e); renderList()
  })
  list.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-jev-id]')
    if (button) activate(button.dataset.jevId!)
  })
  runButton.addEventListener('click', () => { void evaluate() })
  cancelButton.addEventListener('click', () => {
    const runId = cancelButton.dataset.run, origin = active
    if (!runId) return
    cancelButton.disabled = true
    void jevApi(`runs/${runId}/cancel`, 'POST', {})
      .then(() => { if (active === origin) void loadRuns() })
      .catch(error => { if (active === origin) message(error.message, true) })
      .finally(() => { cancelButton.disabled = false })
  })
  el.querySelector('.jev-back')!.addEventListener('click', () => { leave(); handlers.close() })
  el.querySelector('.jev-memories')!.addEventListener('click', handlers.memories)
  el.querySelector('.jev-run-select')!.addEventListener('change', event => {
    selectedRun = (event.target as HTMLSelectElement).value; renderRuns()
  })
  el.querySelector('.jev-older')!.addEventListener('click', () => { void loadRuns(true) })
  el.querySelector('.jev-copy-request')!.addEventListener('click', () => { if (preview) void copy(preview) })
  el.querySelector('.jev-close-template')!.addEventListener('click', () => { el.querySelector<HTMLElement>('.jev-template')!.hidden = true })
  el.querySelector('.jev-use-template')!.addEventListener('click', () => {
    const snippet = templates[Number(el.querySelector<HTMLSelectElement>('.jev-template select')!.value)]
    if (snippet) void create(draftFromRequest(validateJevRequest(JSON.parse(snippet.replace))))
  })
  el.querySelector('.jev-result-actions')!.addEventListener('click', event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-result]')?.dataset.result
    const run = runs.find(run => run.id === selectedRun), e = current()
    if (!run || !e) return
    if (action === 'copy') { void copy(run.result); return }
    if (action === 'edit') { void create(draftFromRequest(run.input || run.request)); return }
    if (action === 'state' && run.result) {
      void create({ ...emptyJevDraft(), state: JSON.stringify(run.result.answers, null, 2), format: 'json' })
      message('Answers copied into State. Edit your next questions, then Evaluate; no other history is sent.')
    }
  })
  el.querySelector('.jev-conflict')!.addEventListener('click', event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-recovery]')?.dataset.recovery, e = current()
    if (!action || !e) return
    void jevApi<{ session: JevSession }>(`sessions/${e.session.id}`).then(async ({ session }) => {
      e.session = session; e.conflict = false; e.error = undefined
      if (action === 'reload') {
        e.draft = parseJevDraft(session.draft); e.title = session.title; e.dirty = false
        if (current() === e) { builder.set(e.draft); title.value = e.title }
      } else await save(e)
      persist(e); controls()
    }).catch(error => message(error.message, true))
  })
  registerReloadGuard(() => {
    const pending = [...entries.values()].some(e => e.saving || e.pendingId)
    const dirty = [...entries.values()].some(e => e.dirty)
    return [...(pending || submitting ? ['command'] : []), ...(dirty ? ['unsaved:jev-builder'] : [])]
  })
  window.addEventListener('beforeunload', event => {
    if (!localSafe && [...entries.values()].some(e => e.dirty)) { event.preventDefault(); event.returnValue = '' }
  })
  async function init() {
    if (initialized) return
    initialized = true
    const generation = navigation
    let restore: string | null = null
    try { restore = sessionStorage.getItem(ACTIVE) } catch { /* optional selection */ }
    try {
      const [config, data] = await Promise.all([jevApi<{ configured: boolean }>('config'), jevApi<{ sessions: JevSession[] }>('sessions')])
      configured = config.configured === true
      if (Array.isArray(data.sessions)) for (const session of data.sessions) accept(session)
      // Preserve every unsaved local workspace, not only the one on screen.
      let localKeys: string[] = []
      try { localKeys = Array.from({ length: sessionStorage.length }, (_, n) => sessionStorage.key(n) || "") } catch { /* Browser storage is optional. */ }
      for (const key of localKeys) {
        if (!key?.startsWith(LOCAL)) continue
        const sessionId = key.slice(LOCAL.length)
        if (entries.has(sessionId)) continue
        try {
          const saved = JSON.parse(sessionStorage.getItem(key) || 'null')
          if (!saved?.dirty || !saved.draft) continue
          const draft = parseJevDraft(JSON.stringify(saved.draft))
          const title = typeof saved.title === 'string' ? saved.title : 'Recovered primitives'
          entries.set(sessionId, { session: { id: sessionId, title, draft: JSON.stringify(draft), revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, title, draft, dirty: true, created: false, pendingId: saved.pendingId, pendingRequest: saved.pendingRequest, creation: saved.creation })
        } catch { /* An unreadable local item cannot hide the server's library. */ }
      }
      renderList()
      if (restore && entries.has(restore) && generation === navigation) { activate(restore); const e = current()!; if (e.pendingId) void reconcilePending(e) }
      controls()
    } catch { initialized = false }
  }
  el.querySelector('.jev-retry-save')!.addEventListener('click', () => { const e = current(); if (e) { e.error = undefined; void save(e) } })
  el.querySelector('.jev-resubmit')!.addEventListener('click', async () => {
    const e = current(), request = e?.pendingRequest, runId = e?.pendingId
    if (!e || !request || !runId || submitting) return
    submitting = true; controls()
    try {
      const { run } = await jevApi<{ run: JevRun }>(`sessions/${e.session.id}/runs`, 'POST', { id: runId, request })
      if (run.id !== runId || run.sessionId !== e.session.id) throw new Error('The evaluation receipt does not match this workspace.')
      if (e.pendingId === runId) { e.pendingId = undefined; e.pendingRequest = undefined; persist(e) }
      if (current() === e) { selectedRun = run.id; message(''); await loadRuns() }
    } catch (error) { if (current() === e) message((error as Error).message, true) }
    finally { submitting = false; controls() }
  })
  el.querySelector('.jev-pending')!.addEventListener('click', () => { const e = current(); if (e) void reconcilePending(e) })
  el.querySelector('.jev-save-template')!.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement
    try {
      const e = current(); if (!e) return
      const replace = JSON.stringify(requestFromDraft(e.draft), null, 2)
      const name = el.querySelector<HTMLInputElement>('.jev-template-name')!.value.trim()
      if (!name) throw new Error('Name the template first.')
      button.disabled = true
      const trigger = name.startsWith(';') ? name : ';' + name.replace(/^\//, '')
      const response = await fetch('/api/snippets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger, replace }), signal: AbortSignal.timeout(15_000) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save the template.')
      if (current() === e) message(`Saved ${trigger} in Snippets. It includes the state and questions, not Memories or results.`)
    } catch (error) { message((error as Error).message, true) }
    finally { button.disabled = false }
  })
  el.querySelector('.jev-delete')!.addEventListener('click', async () => {
    const e = current(); if (!e || submitting || e.deleting || !window.confirm(`Delete “${e.title}” and its evaluation history?`)) return
    try {
      submitting = true; e.deleting = true; clearTimeout(saveTimer); controls()
      await e.saving
      if (e.created) await jevApi(`sessions/${e.session.id}`, 'DELETE')
      entries.delete(e.session.id)
      try { sessionStorage.removeItem(LOCAL + e.session.id) } catch { /* optional draft cache */ }
      if (current() === undefined) { leave(); handlers.close() }
      renderList()
    } catch (error) { e.deleting = false; if (current() === e) message((error as Error).message, true) }
    finally { submitting = false; controls() }
  })
  return { el, init, create, leave, pause() { pollingPaused = true; clearTimeout(pollTimer) }, resume() { pollingPaused = false; if (visible) void loadRuns() }, get visible() { return visible }, get configured() { return configured } }
}
