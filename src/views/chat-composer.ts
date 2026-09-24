import type { ChatSwitch } from '../chat-switches'
// Chat composer — the chat pane's composer habits (mode-lock chip, auto-
// resize, attachment chips, Enter sends / Shift+Enter newline) plus what a
// coding session needs on top: `@` file mentions, a `/` command palette, and
// Send ↔ Stop ↔ Steer while a turn runs.
//
// The composer knows nothing about sessions. The view feeds it the session's
// commands and state, keeps one draft per session, and receives plain
// callbacks: send, steer, stop, and Poise's own commands (/model, /mode,
// /fork). The file input, paste and drop all funnel into one upload path.

import type { Attachment, CommandOption, Mention } from '../../server/chat/protocol'
import { escapeHtml } from '../markdown'
import { parseChatCommandChain as parseChain, modelCompletion as completeModel, commandBody } from '../../server/chat/commands'
import { commandDraftText, editableCommandDraft } from '../chat-command-draft'
import { createCommandModels } from './chat-command-models'
import type { AgentInfo } from '../chat-client'
import { consoleModelLabel } from '../chat-catalog'
import { attachModelPicker } from './chat-model-picker'
import { createMessageHistory } from './chat-message-history'
import type { MessageHistorySnapshot } from '../chat-message-history'

export interface ComposerDraft {
  /** Optional per-message model choice; applied only when submitted. */
  model?: string
  text: string
  attachments: Attachment[]
  mentions: Mention[]
  mode: string | null
}

export interface ComposerState {
  /** A turn is running: Enter steers, the button stops. */
  running: boolean
  /** Defer interjections while native context maintenance runs. */
  maintaining?: boolean
  /** Nothing can be sent; `placeholder` says why. */
  disabled: boolean
  placeholder?: string
  /** Draft model choice, shown before a session is created. */
  modelLabel?: string
  modelIdentity?: string
  /** Offer a Resume button (the session was interrupted). */
  resume?: boolean
  /** Whether the session has an upload target. */
  sessionId: string | null
}

export interface ComposerHandlers {
  onJev?(): void
  jevAvailable?(): boolean
  history(): MessageHistorySnapshot
  onSend(draft: ComposerDraft): void
  onQueue(draft: ComposerDraft): void
  loadModels(): Promise<AgentInfo[]>
  onModelSelect(identity: string): void
  onSteer(draft: ComposerDraft): void
  onStop(): void
  onResume(): void
  /** `/model x`, `/mode y`, `/fork` — Poise's own commands. */
  onCommand(name: string, arg: string): void
  /** Lazily create an upload target for an untouched console. */
  prepareUpload(): Promise<string>
  upload(file: File, sessionId: string): Promise<Attachment>
  searchFiles(q: string): Promise<string[]>
}

export interface Composer {
  el: HTMLElement
  history: ReturnType<typeof createMessageHistory>
  models: ReturnType<typeof createCommandModels>
  setCommands(agentCommands: CommandOption[], own: { model?: boolean, modes: boolean, fork: boolean, poise?: boolean }): void
  setState(state: ComposerState): void
  setSwitches(switches: ChatSwitch[]): void
  getDraft(): ComposerDraft
  setDraft(draft: ComposerDraft | null): void
  focus(): void
  /** Recompute the textarea height, e.g. after the composer became visible. */
  layout(): void
  /** A File is on its way to the server; it cannot be carried across a reload. */
  isUploading(): boolean
}

export function emptyDraft(): ComposerDraft {
  return { text: '', attachments: [], mentions: [], mode: null }
}

const ICON_SEND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>'
const ICON_STOP = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'
const ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

/** Auto-resize: a scrollHeight past this, or an explicit newline, is multiline. */
const MULTILINE_THRESHOLD_PX = 50
/** Growth cap; beyond it the textarea scrolls inside itself. */
const MAX_INPUT_PX = 120
const MENTION_DEBOUNCE_MS = 120
const STEER_HINT_MS = 2000
const DEFAULT_PLACEHOLDER = 'Message…'

const OWN_COMMANDS: CommandOption[] = [
  { name: 'create', description: 'Save a reusable switch', hint: '/name instructions' },
  { name: 'model', description: 'Choose model and effort' },
  { name: 'compact', description: 'Compact model context; keep chat history' },
  { name: 'reset', description: 'Clear chat history and start fresh' },
  { name: 'review', description: 'Critically review the latest reply', hint: '[focus]' },
  { name: 'mode', description: 'Switch mode', hint: '<mode>' },
  { name: 'fork', description: 'Fork this session' },
  { name: 'queue', description: 'Queue a message after the current or next task', hint: '<message>' },
  { name: 'poise', description: 'Implement and release a Poise change', hint: '<request>' },
]

export function createComposer(handlers: ComposerHandlers): Composer {
  const el = document.createElement('form')
  el.className = 'chat-composer chat-v-composer'
  el.innerHTML = `
    <div class="chat-command-chips" hidden></div>
    <div class="chat-input-wrap">
      <div class="chat-attachments" hidden></div>
      <div class="chat-input-row">
        <span class="chat-mode-chip chat-v-chip" aria-live="polite" hidden></span>
        <textarea class="chat-input" rows="1" placeholder="${DEFAULT_PLACEHOLDER}" spellcheck="true" aria-label="Message"></textarea>
      </div>
      <div class="chat-controls">
        <button class="chat-attach" type="button" aria-label="Attach file" title="Attach file">${ICON_PLUS}</button>
        <div class="chat-model-control" hidden>
          <button type="button" class="chat-default-model" aria-haspopup="listbox" aria-expanded="false" aria-controls="chat-console-models" title="Choose model and effort">
            <span class="chat-model-label"></span>
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div id="chat-console-models" class="chat-model-menu" role="listbox" aria-label="Console model" tabindex="-1" hidden></div>
        </div>
        <span class="chat-steer-hint" hidden>steering</span>
        <span class="chat-controls-spacer"></span>
        <button class="chat-resume-btn" type="button" hidden>Resume</button>
        <button class="chat-send" type="submit" aria-label="Send" title="Send (Enter)">${ICON_SEND}</button>
      </div>
      <div class="chat-popover" role="listbox" hidden></div>
    </div>
    <input class="chat-file-input" type="file" multiple hidden />
  `
  const wrap = el.querySelector<HTMLElement>('.chat-input-wrap')!
  const input = el.querySelector<HTMLTextAreaElement>('.chat-input')!
  const chip = el.querySelector<HTMLElement>('.chat-v-chip')!
  const chipsEl = el.querySelector<HTMLElement>('.chat-attachments')!
  const sendBtn = el.querySelector<HTMLButtonElement>('.chat-send')!
  const attachBtn = el.querySelector<HTMLButtonElement>('.chat-attach')!
  const resumeBtn = el.querySelector<HTMLButtonElement>('.chat-resume-btn')!
  const fileInput = el.querySelector<HTMLInputElement>('.chat-file-input')!
  const steerHint = el.querySelector<HTMLElement>('.chat-steer-hint')!
  const modelPicker = attachModelPicker(el.querySelector<HTMLElement>('.chat-model-control')!, {
    onJev: handlers.onJev, jevAvailable: handlers.jevAvailable,
    loadModels: handlers.loadModels, onSelect: identity => { selectedModel = undefined; renderSelectedModel(); handlers.onModelSelect(identity); changed() },
  })
  const popover = el.querySelector<HTMLElement>('.chat-popover')!

  let uploading = 0
  let attachments: Attachment[] = []
  let mentions: Mention[] = []
  let activeMode: string | null = null
  let selectedModel: string | undefined
  let agentCommands: CommandOption[] = []
  let customCommands: CommandOption[] = []
  let switchNames = new Set<string>()
  const parseChatCommandChain = (text: string) => parseChain(text, switchNames)
  const modelCompletion = (text: string) => completeModel(text, switchNames)
  let ownCommands: CommandOption[] = OWN_COMMANDS.filter(command => ['model', 'create'].includes(command.name))
  let state: ComposerState = { running: false, disabled: true, sessionId: null }
  let steerTimer: ReturnType<typeof setTimeout> | null = null

  const history = createMessageHistory(input, {
    read: handlers.history,
    recall: entry => {
      setComposerDraft(entry.draft)
      input.setSelectionRange(input.value.length, input.value.length)
      el.dispatchEvent(new Event('chat:composer-change', { bubbles: true }))
    },
    changed: () => el.dispatchEvent(new Event('chat:composer-change', { bubbles: true })),
  })

  const commandChips = el.querySelector<HTMLElement>('.chat-command-chips')!
  function changed(): void { el.dispatchEvent(new Event('chat:composer-change', { bubbles: true })) }
  function rawDraft(): ComposerDraft {
    return { text: input.value, attachments: attachments.slice(), mentions: currentMentions(), mode: activeMode, ...(selectedModel ? { model: selectedModel } : {}) }
  }
  function renderSelectedModel(): void {
    commandChips.hidden = !selectedModel
    commandChips.innerHTML = selectedModel ? `<span class="chat-command-model-chip"><span>${escapeHtml(consoleModelLabel(selectedModel))}</span><button type="button" class="chat-icon-btn" aria-label="Clear model">×</button></span>` : ''
  }
  commandChips.addEventListener('click', event => {
    if (!(event.target as HTMLElement).closest('button')) return
    selectedModel = undefined; renderSelectedModel(); applyState(); changed(); input.focus()
  })
  function canChainMode(): boolean {
    return !activeMode || activeMode.split(/\s+/).every(name => (['queue', 'review', 'compact', 'reset'].includes(name.replace(/^\//, '')) || switchNames.has(name.replace(/^\//, ''))))
  }
  const models = createCommandModels(input, {
    load: handlers.loadModels, changed,
    choose: identity => {
      const location = modelCompletion(input.value)
      if (!location) return
      input.value = [input.value.slice(0, location.start).trimEnd(), input.value.slice(location.end).trimStart()].filter(Boolean).join(' ')
      selectedModel = identity
      renderSelectedModel(); applyState(); autoResize(); closePopover(); changed()
      input.setSelectionRange(input.value.length, input.value.length)
    },
  })
  function updateModels(): boolean {
    const location = canChainMode() && !state.disabled && !uploading ? modelCompletion(input.value) : null
    if (!location) { models.close(); return false }
    history.close(); closePopover(); modelPicker.close()
    models.show(location.query, selectedModel || state.modelIdentity || '')
    return true
  }

  // ── Auto-resize ───────────────────────────────────────────────────────
  // Single-line height comes from the computed line-height plus vertical
  // padding, so the type scale can change without a magic number here. Past
  // the threshold (or with an explicit newline) the height is an explicit
  // line-count estimate, capped; only beyond the cap does it scroll.
  function autoResize(): void {
    const cs = getComputedStyle(input)
    const lh = parseFloat(cs.lineHeight) || 19
    const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const single = Math.ceil(lh + padV)
    const minimum = Math.max(single, parseFloat(cs.minHeight) || 0)
    input.style.height = 'auto'
    const sh = input.scrollHeight
    const multiline = input.value.includes('\n') || sh > Math.max(MULTILINE_THRESHOLD_PX, minimum + 1)
    wrap.classList.toggle('multiline', multiline)
    let wanted = single
    if (multiline) {
      const lines = Math.max(input.value.split('\n').length, Math.round((sh - padV) / lh))
      wanted = Math.ceil(lines * lh + padV)
    }
    const height = Math.min(Math.max(wanted, minimum), MAX_INPUT_PX)
    input.style.height = `${height}px`
    input.style.overflowY = wanted > MAX_INPUT_PX ? 'auto' : 'hidden'
  }

  // ── Mode-lock chip ────────────────────────────────────────────────────

  function allCommands(): CommandOption[] {
    const local = [...ownCommands, ...customCommands]
    return [...local, ...agentCommands.filter(command => !local.some(own => own.name === command.name))]
  }

  function applyMode(mode: string | null): void {
    activeMode = mode
    if (!mode) {
      chip.hidden = true
      chip.textContent = ''
      chip.removeAttribute('title')
      wrap.classList.remove('mode-locked')
      input.style.paddingLeft = ''
      applyState()
      return
    }
    chip.textContent = `/${mode}`
    chip.title = `/${mode}`
    chip.hidden = false
    wrap.classList.add('mode-locked')
    // The chip sits inside the textarea's box; its rendered width decides the
    // text inset, so a long command name never collides with the caret.
    const width = chip.getBoundingClientRect().width
    const base = parseFloat(getComputedStyle(input).paddingRight) || 12
    input.style.paddingLeft = `${Math.ceil(base + width + 6)}px`
    applyState()
  }

  // Space at end-of-input with the value exactly `/<command>` locks the chip.
  function tryEnterMode(e: KeyboardEvent): boolean {
    if (!canChainMode() || e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return false
    if (input.selectionStart !== input.selectionEnd) return false
    if (input.selectionStart !== input.value.length) return false
    const t = input.value.trim().toLowerCase()
    if (!t.startsWith('/')) return false
    const match = allCommands().find((c) => `/${c.name.toLowerCase()}` === t)
    if (!match) return false
    e.preventDefault()
    if (match.name === 'model') { input.value = '/model '; updateModels(); autoResize(); return true }
    input.value = ''
    autoResize()
    applyMode(activeMode ? `${activeMode} /${match.name}` : match.name)
    closePopover()
    return true
  }

  // Backspace/Delete at position 0, or Cmd/Ctrl+X anywhere, unlocks.
  function tryExitMode(e: KeyboardEvent): boolean {
    if (!activeMode) return false
    if ((e.metaKey || e.ctrlKey) && (e.key === 'x' || e.key === 'X')) {
      applyMode(null)
      return true
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault()
      applyMode(null)
      return true
    }
    return false
  }

  // ── Attachments ───────────────────────────────────────────────────────

  function renderChips(): void {
    if (!attachments.length) {
      chipsEl.hidden = true
      chipsEl.innerHTML = ''
      return
    }
    chipsEl.hidden = false
    chipsEl.innerHTML = attachments.map((a) => `
      <span class="chat-attachment-chip" title="${escapeHtml(a.path)} · ${a.size} bytes">
        <span class="chat-attachment-name">${escapeHtml(a.name)}</span>
        <button type="button" class="chat-attachment-remove" data-path="${escapeHtml(a.path)}" aria-label="Remove ${escapeHtml(a.name)}">×</button>
      </span>`).join('')
  }

  async function uploadFiles(files: File[]): Promise<void> {
    if (state.disabled || uploading) return
    history.close(); models.close()
    uploading += 1
    applyState()
    let target = state.sessionId
    try {
      target ||= await handlers.prepareUpload()
      for (const file of files) {
        try {
          const attachment = await handlers.upload(file, target)
          // The view saves an off-screen upload in that session's own draft.
          if (state.sessionId === target) {
            attachments.push(attachment)
            renderChips()
          }
        } catch (err) {
          if (state.sessionId === target) showNote(`Couldn't attach "${file.name}": ${(err as Error).message}`)
        }
      }
    } catch (err) {
      showNote(`Couldn't attach: ${(err as Error).message}`)
    } finally {
      uploading -= 1
      applyState()
    }
  }

  let noteTimer: ReturnType<typeof setTimeout> | null = null
  function showNote(text: string): void {
    steerHint.textContent = text
    steerHint.hidden = false
    if (noteTimer) clearTimeout(noteTimer)
    noteTimer = setTimeout(() => { steerHint.hidden = true; steerHint.textContent = 'steering' }, 4000)
  }

  // ── Popover: `/` palette and `@` mentions ─────────────────────────────

  type PopItem = { label: string, hint?: string, value: string }
  let popKind: 'command' | 'mention' | null = null
  let pendingCommandQuery: string | null = null
  let popItems: PopItem[] = []
  let popIndex = 0
  let commandStart = 0
  let mentionStart = -1
  let mentionTimer: ReturnType<typeof setTimeout> | null = null
  let mentionSeq = 0

  function closePopover(): void {
    pendingCommandQuery = null
    mentionSeq++
    if (mentionTimer) { clearTimeout(mentionTimer); mentionTimer = null }
    popKind = null
    popItems = []
    popover.hidden = true
    popover.innerHTML = ''
  }

  function renderPopover(): void {
    if (!popKind || !popItems.length) { closePopover(); return }
    popover.hidden = false
    popover.dataset.kind = popKind
    popover.innerHTML = popItems.map((it, i) =>
      `<button type="button" class="chat-pop-item${i === popIndex ? ' active' : ''}" role="option" aria-selected="${i === popIndex}" data-index="${i}">`
      + `<span class="chat-pop-label">${escapeHtml(it.label)}</span>${it.hint ? `<span class="chat-pop-hint">${escapeHtml(it.hint)}</span>` : ''}</button>`).join('')
    popover.querySelector<HTMLElement>('.chat-pop-item.active')?.scrollIntoView({ block: 'nearest' })
  }

  function updatePalette(): void {
    if (updateModels()) return
    const v = input.value
    const token = /\/([^\s/]*)$/.exec(v)
    const prefix = token ? v.slice(0, token.index) : ''
    const chain = parseChatCommandChain(prefix)
    if (!canChainMode() || !token || chain.text || chain.missingModel || (prefix && !/\s$/.test(prefix))) {
      if (popKind === 'command') closePopover()
      return
    }
    commandStart = token.index
    const q = token[1].toLowerCase()
    const items = allCommands().filter((c) => c.name.toLowerCase().startsWith(q))
    popKind = 'command'
    popItems = items.map((c) => ({ label: `/${c.name}`, hint: [c.hint, c.description].filter(Boolean).join(' — '), value: c.name }))
    popIndex = 0
    renderPopover()
    if (!popItems.length) pendingCommandQuery = v
  }

  function mentionQuery(): { start: number, q: string } | null {
    const caret = input.selectionStart
    const before = input.value.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at < 0) return null
    if (at > 0 && !/\s/.test(before[at - 1])) return null
    const q = before.slice(at + 1)
    if (/\s/.test(q)) return null
    return { start: at, q }
  }

  function updateMentions(): void {
    const m = parseChatCommandChain(commandDraftText(rawDraft())).create ? null : mentionQuery()
    if (!m || !state.sessionId) {
      if (popKind === 'mention') closePopover()
      return
    }
    mentionStart = m.start
    if (mentionTimer) clearTimeout(mentionTimer)
    const seq = ++mentionSeq
    mentionTimer = setTimeout(async () => {
      let files: string[] = []
      try { files = await handlers.searchFiles(m.q) } catch { files = [] }
      if (seq !== mentionSeq) return
      const again = mentionQuery()
      if (!again) return
      popKind = 'mention'
      popItems = files.slice(0, 30).map((f) => ({ label: f, value: f }))
      popIndex = 0
      renderPopover()
    }, MENTION_DEBOUNCE_MS)
  }

  function acceptPopover(index: number): void {
    const item = popItems[index]
    if (!item || !popKind) return
    if (popKind === 'command') {
      const prefix = input.value.slice(0, commandStart)
      closePopover()
      if (item.value === 'model') {
        input.value = `${prefix}/model `
        updateModels()
      } else if (!prefix.trim()) {
        applyMode(activeMode ? `${activeMode} /${item.value}` : item.value)
        input.value = ''
      } else input.value = `${prefix}/${item.value} `
      autoResize(); changed()
      return
    }
    const caret = input.selectionStart
    const before = input.value.slice(0, mentionStart)
    const after = input.value.slice(caret)
    input.value = `${before}@${item.value} ${after}`
    const pos = before.length + item.value.length + 2
    input.setSelectionRange(pos, pos)
    if (!mentions.some((x) => x.path === item.value)) mentions.push({ path: item.value })
    closePopover()
    autoResize()
  }

  function popoverKey(e: KeyboardEvent): boolean {
    if (!popKind || !popItems.length) return false
    if (e.key === 'ArrowDown') { popIndex = (popIndex + 1) % popItems.length; renderPopover(); e.preventDefault(); return true }
    if (e.key === 'ArrowUp') { popIndex = (popIndex - 1 + popItems.length) % popItems.length; renderPopover(); e.preventDefault(); return true }
    if (e.key === 'Enter' && !e.shiftKey) { acceptPopover(popIndex); e.preventDefault(); return true }
    if (e.key === 'Tab') { acceptPopover(popIndex); e.preventDefault(); return true }
    if (e.key === 'Escape') { closePopover(); e.preventDefault(); return true }
    return false
  }

  // ── Send / steer / stop ───────────────────────────────────────────────

  function currentMentions(): Mention[] {
    // A mention the person deleted from the text is not sent.
    return mentions.filter((m) => input.value.includes(`@${m.path}`))
  }

  function submit(): void {
    if (uploading) return
    const draft = rawDraft()
    draft.text = commandDraftText(draft)
    const chain = parseChatCommandChain(draft.text)
    if (state.disabled && !(state.resume && ((chain.context === 'reset' && !chain.queue) || chain.create))) return
    if (chain.missingModel) { updateModels(); return }
    if (!chain.text && !chain.review && !chain.model && !chain.context && !chain.switches?.length && !chain.create && !attachments.length) return
    if (state.running && chain.model && !chain.text && !chain.switches?.length && !chain.review && !chain.context && !attachments.length) {
      showNote('Model chosen for the next task'); return
    }
    if (chain.create) handlers.onSend(draft)
    else if (chain.queue || (state.running && chain.context !== 'reset' && (chain.context || chain.review || chain.model || state.maintaining))) {
      if (!chain.text && !chain.switches?.length && !chain.review && !chain.context && !attachments.length) return
      handlers.onQueue({ ...draft, text: commandBody(chain), mode: 'queue', ...(chain.model ? { model: chain.model } : {}) })
    } else if (state.running && chain.context !== 'reset') {
      if (!draft.text && !draft.attachments.length) return
      handlers.onSteer(draft)
      input.value = ''; attachments = []; mentions = []; selectedModel = undefined
      renderChips(); renderSelectedModel(); changed()
      applyMode(null); autoResize(); closePopover()
      steerHint.textContent = 'steering'; steerHint.hidden = false
      if (steerTimer) clearTimeout(steerTimer)
      steerTimer = setTimeout(() => { steerHint.hidden = true }, STEER_HINT_MS)
      return
    } else handlers.onSend(draft)
    input.value = ''; attachments = []; mentions = []; selectedModel = undefined
    renderChips(); renderSelectedModel(); applyMode(null); autoResize()
    models.close(); closePopover(); changed()
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  el.addEventListener('submit', (e) => {
    e.preventDefault()
    const chain = parseChatCommandChain(commandDraftText(rawDraft()))
    if (state.disabled && !(state.resume && ((chain.context === 'reset' && !chain.queue) || chain.create))) return
    if (state.running && !chain.create && !chain.switches?.length && !chain.context && !chain.queue && !chain.review && !chain.model && !chain.missingModel && !(state.maintaining && (chain.text || attachments.length))) handlers.onStop()
    else submit()
  })
  input.addEventListener('input', () => {
    history.close()
    applyState()
    autoResize()
    updatePalette()
    if (!models.open) updateMentions()
  })
  let composing = false
  input.addEventListener('compositionstart', () => { composing = true; history.close(); models.close() })
  input.addEventListener('compositionend', () => { composing = false })
  let recalledOnEnter = false
  input.addEventListener('keyup', event => { if (event.key === 'Enter') recalledOnEnter = false })
  input.addEventListener('keydown', (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return
    // Holding Enter to recall must not send the message on the next repeat.
    if (e.key === 'Enter' && recalledOnEnter) { e.preventDefault(); return }
    if (models.key(e)) { if (e.key === 'Enter') recalledOnEnter = true; return }
    const canOpenHistory = !state.disabled && !uploading && !input.value && !activeMode && !selectedModel && !attachments.length && !popKind
    if (history.key(e, canOpenHistory)) {
      if (e.key === 'Enter') recalledOnEnter = true
      modelPicker.close()
      closePopover()
      return
    }
    if (e.key === 'Escape') { closePopover(); return }
    if (popoverKey(e)) { if (e.key === 'Enter') recalledOnEnter = true; return }
    if (tryEnterMode(e)) return
    if (tryExitMode(e)) return
    if ((e.metaKey || e.ctrlKey) && e.key === '.') {
      e.preventDefault()
      if (state.running) handlers.onStop()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  })
  input.addEventListener('blur', () => {
    // Give a click on a popover item time to land before the list goes.
    setTimeout(() => { if (!popover.contains(document.activeElement)) closePopover() }, 150)
  })
  input.addEventListener('paste', (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || [])
    if (!files.length) return
    e.preventDefault()
    void uploadFiles(files)
  })
  wrap.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    wrap.classList.add('drag-over')
  })
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'))
  wrap.addEventListener('drop', (e) => {
    wrap.classList.remove('drag-over')
    const files = Array.from(e.dataTransfer?.files || [])
    if (!files.length) return
    e.preventDefault()
    void uploadFiles(files)
  })
  popover.addEventListener('mousedown', (e) => e.preventDefault())
  popover.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.chat-pop-item')
    if (!btn) return
    acceptPopover(Number(btn.dataset.index))
    input.focus()
  })
  attachBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || [])
    if (files.length) void uploadFiles(files)
    fileInput.value = ''
  })
  resumeBtn.addEventListener('click', () => handlers.onResume())
  chipsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.chat-attachment-remove')
    if (!btn) return
    attachments = attachments.filter((a) => a.path !== btn.dataset.path)
    renderChips()
  })

  function applyState(): void {
    input.disabled = state.disabled && !state.resume
    attachBtn.disabled = state.disabled || uploading > 0
    const chain = parseChatCommandChain(commandDraftText(rawDraft()))
    const creating = chain.create === true
    const resetting = chain.context === 'reset' && !chain.queue && !creating
    const hasContent = !!chain.text || !!chain.switches?.length || !!attachments.length
    const queuing = !creating && (chain.queue || (state.running && !resetting && (!!chain.model || chain.review || chain.missingModel || !!chain.context || (state.maintaining && hasContent))))
    const stopping = state.running && !queuing && !resetting && !creating && !chain.switches?.length
    input.placeholder = creating ? '/switch-name Instructions to save…' : state.disabled ? (state.placeholder || 'Unavailable') : (queuing || state.maintaining) ? 'Queue a follow-up…' : (state.running ? 'Steer the agent… (Enter)' : (state.placeholder || DEFAULT_PLACEHOLDER))
    sendBtn.disabled = (state.disabled && !(state.resume && (resetting || creating))) || (uploading > 0 && (queuing || resetting || creating || !state.running))
    modelPicker.setState({ identity: state.modelIdentity || '', label: state.modelLabel || '', visible: !!state.modelLabel, disabled: state.disabled || uploading > 0 })
    const icon = stopping ? 'stop' : 'send'
    if (sendBtn.dataset.icon !== icon) { sendBtn.innerHTML = stopping ? ICON_STOP : ICON_SEND; sendBtn.dataset.icon = icon }
    const label = creating ? 'Save switch' : resetting ? 'Reset chat' : queuing ? 'Queue message' : stopping ? 'Stop' : state.running ? 'Steer' : 'Send'
    sendBtn.setAttribute('aria-label', label)
    sendBtn.title = label
    sendBtn.classList.toggle('is-stop', stopping)
    resumeBtn.hidden = !state.resume
    if (state.disabled) { closePopover(); history.close(); models.close() }
  }
  applyState()
  autoResize()
  let observedWidth = 0
  const widthObserver = new ResizeObserver(([box]) => {
    if (!box || !box.contentRect.width || box.contentRect.width === observedWidth) return
    observedWidth = box.contentRect.width
    // Resize the text outside observer delivery, avoiding a resize loop when
    // wrapping changes the composer height while its width is animating.
    requestAnimationFrame(() => { if (activeMode) applyMode(activeMode); autoResize() })
  })
  widthObserver.observe(el)

  function setComposerDraft(draft: ComposerDraft | null): void {
    history.close()
    modelPicker.close()
    models.close()
    const restored = editableCommandDraft(draft || emptyDraft())
    const d = restored.mode === 'model' ? { ...restored, mode: null, text: `/model ${restored.text}` } : restored
    selectedModel = d.model
    renderSelectedModel()
    input.value = d.text
    attachments = d.attachments.map(file => ({ ...file }))
    mentions = d.mentions.map(mention => ({ ...mention }))
    renderChips()
    applyMode(d.mode)
    closePopover()
    autoResize()
  }

  return {
    el, history, models,
    setCommands(list, own) {
      agentCommands = list
      ownCommands = OWN_COMMANDS.filter((c) => c.name === 'create' || c.name === 'queue' || c.name === 'review' || c.name === 'compact' || c.name === 'reset' || (c.name === 'model' && own.model !== false) || (c.name === 'mode' && own.modes) || (c.name === 'fork' && own.fork) || (c.name === 'poise' && own.poise !== false))
    },
    setSwitches(switches) {
      switchNames = new Set(switches.map(item => item.name))
      customCommands = switches.map(item => ({ name: item.name, description: item.content.replace(/\s+/g, ' ').slice(0, 90), hint: 'Saved switch' }))
      applyState()
      if (popKind === 'command' || (pendingCommandQuery === input.value && document.activeElement === input)) updatePalette()
    },
    setState(next) {
      // The view calls this on every render, including each streamed delta;
      // only a real change touches the DOM.
      const same = state.running === next.running && state.maintaining === next.maintaining && state.disabled === next.disabled
        && state.modelIdentity === next.modelIdentity && state.modelLabel === next.modelLabel && state.placeholder === next.placeholder && state.resume === next.resume && state.sessionId === next.sessionId
      if (state.sessionId !== next.sessionId) { history.close(); models.close(); closePopover() }
      state = next
      if (!same) applyState()
      history.refresh()
    },
    getDraft() {
      return { text: input.value, attachments: attachments.slice(), mentions: mentions.slice(), mode: activeMode, ...(selectedModel ? { model: selectedModel } : {}) }
    },
    setDraft: setComposerDraft,
    focus() { input.focus() },
    layout() { if (activeMode) applyMode(activeMode); autoResize(); modelPicker.layout() },
    isUploading() { return uploading > 0 },
  }
}
