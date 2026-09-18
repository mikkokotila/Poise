import { getMeta, setMeta } from './db'
import { invalidateRepoListCache } from './gh'
import { type Catalog, type ModelSettings, isModelPlace, validateModelSettings } from './models'

// GitHub logins and organization names: 1–39 characters, alphanumerics and
// single hyphens, not leading or trailing. Stored with nothing but .trim()
// before, so a pasted URL saved cleanly and every query built from it came
// back empty with no indication why.
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

export interface Settings {
  org: string
  me: string
  timezone: string
  // Per place: the identity the user picked as default and as fallback. What
  // actually launches is resolved against the live catalog (server/models.ts).
  models: ModelSettings
  chat: ChatSettings
}

// Chat v1 (server/chat): the prefix of branches new sessions cut from the
// default branch, and how long an idle agent process is kept alive.
export interface ChatSettings {
  branchPrefix: string
  idleTimeoutMinutes: number
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { branchPrefix: 'chat/', idleTimeoutMinutes: 120 }
const BRANCH_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}\/$/

export function getChatSettings(): ChatSettings {
  const raw = getMeta('chat_settings')
  if (!raw) return { ...DEFAULT_CHAT_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<ChatSettings>
    return {
      branchPrefix: typeof parsed.branchPrefix === 'string' && BRANCH_PREFIX.test(parsed.branchPrefix) ? parsed.branchPrefix : DEFAULT_CHAT_SETTINGS.branchPrefix,
      idleTimeoutMinutes: Number.isSafeInteger(parsed.idleTimeoutMinutes) && Number(parsed.idleTimeoutMinutes) >= 0 ? Number(parsed.idleTimeoutMinutes) : DEFAULT_CHAT_SETTINGS.idleTimeoutMinutes,
    }
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS }
  }
}

function validateChatSettings(value: unknown): ChatSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('chat settings must be an object')
  const current = getChatSettings()
  const input = value as Record<string, unknown>
  const next = { ...current }
  if ('branchPrefix' in input) {
    const prefix = String(input.branchPrefix ?? '').trim()
    if (!BRANCH_PREFIX.test(prefix)) throw new Error('branch prefix must be a short branch namespace ending in /, like chat/')
    next.branchPrefix = prefix
  }
  if ('idleTimeoutMinutes' in input) {
    const minutes = Number(input.idleTimeoutMinutes)
    if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 10_080) throw new Error('idle timeout must be a whole number of minutes between 0 and 10080')
    next.idleTimeoutMinutes = minutes
  }
  return next
}

const TEXT_KEYS = ['org', 'me', 'timezone'] as const

// Before identities the only choice was `reviewModel` = opus | astra. Read it
// once as the review places' preference so nobody's setting silently flips.
function legacyReviewModels(): ModelSettings {
  const legacy = getMeta('reviewModel')
  if (legacy !== 'astra') return {}
  const choice = { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' }
  return { pr_review: choice, pr_approve: choice }
}

export function getModelSettings(): ModelSettings {
  const raw = getMeta('models')
  if (!raw) return legacyReviewModels()
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const models: ModelSettings = {}
  for (const [place, value] of Object.entries(parsed as Record<string, any>)) {
    if (isModelPlace(place) && typeof value?.default === 'string' && typeof value?.fallback === 'string') {
      models[place] = {
        default: value.default,
        fallback: value.fallback,
        ...(typeof value.secondary === 'string' ? { secondary: value.secondary } : {}),
        ...(typeof value.tertiary === 'string' ? { tertiary: value.tertiary } : {}),
      }
    }
  }
  return models
}

export function getSettings(): Settings {
  return {
    org: getMeta('org') || '',
    me: getMeta('me') || '',
    timezone: getMeta('timezone') || '',
    models: getModelSettings(),
    chat: getChatSettings(),
  }
}

// Validate everything before writing anything: the loop below writes key by
// key, so a value rejected halfway used to leave the earlier ones applied.
// `models` needs the catalog to validate, so the caller passes it in; without
// one the models part is left untouched.
export function setSettings(partial: Partial<Settings>, catalog?: Catalog): Settings {
  const next: Partial<Settings> = {}
  for (const k of TEXT_KEYS) {
    const v = partial[k]
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    if ((k === 'org' || k === 'me') && trimmed && !GITHUB_NAME.test(trimmed)) {
      throw new Error(`${k} must be a GitHub name: letters, digits and single hyphens`)
    }
    next[k] = trimmed
  }
  let models: ModelSettings | undefined
  if ('models' in partial && partial.models !== undefined) {
    if (!catalog) throw new Error('the model catalog is unavailable; model settings were not saved')
    models = { ...getModelSettings(), ...validateModelSettings(catalog, partial.models) }
  }
  let chat: ChatSettings | undefined
  if ('chat' in partial && partial.chat !== undefined) chat = validateChatSettings(partial.chat)
  const orgChanged = typeof next.org === 'string' && next.org !== (getMeta('org') || '')
  for (const k of TEXT_KEYS) {
    const v = next[k]
    if (typeof v === 'string') setMeta(k, v)
  }
  if (models) setMeta('models', JSON.stringify(models))
  if (chat) setMeta('chat_settings', JSON.stringify(chat))
  if (orgChanged) invalidateRepoListCache()
  return getSettings()
}

export function isReady(): boolean {
  const s = getSettings()
  return !!(s.org && s.me)
}
