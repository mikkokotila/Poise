// The model catalog and where Poise uses it.
//
// Caller owns the names: `agent-interface --models` exports one row per
// identity (<family>-<version>-<effort>) with the provider CLI behind it and
// the default per Caller behavior. Poise never spells a model name itself; it
// reads this catalog, lets the user pick a default and a fallback for each
// place that launches a model, and resolves those against the live catalog on
// every launch — a refresh can retire an identity overnight.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runFile } from './process'

export interface CatalogModel {
  identity: string
  provider: string
  selector: string
  effort: string
}

export interface Catalog {
  schema_version: number
  path: string
  models: CatalogModel[]
  behaviors: Record<string, string>
  debate_participants: string[]
  review_providers: string[]
  policy: string
}

export const REVIEW_POLICY = 'bounded-v1'
const CATALOG_TTL_MS = 60_000
const CATALOG_PROBE_TIMEOUT_MS = 30_000

// The Claude models Caller used before identities carried their provider.
// Only the calls log still shows them; new rows always resolve via the catalog.
const RETIRED_CLAUDE_PREFIXES = ['opus-', 'fable-', 'sonnet-', 'haiku-']

export function agentInterfaceCwd(): string {
  return process.env.AGENT_INTERFACE_ROOT || join(homedir(), 'dev', 'caller', 'agent_interface')
}

let cached: { at: number, catalog: Catalog } | null = null
let pending: Promise<Catalog> | null = null

export function invalidateCatalog(): void {
  cached = null
}

function parseCatalog(stdout: string): Catalog {
  let data: any
  try { data = JSON.parse(stdout) } catch { throw new Error('Update Caller: the model catalog is unavailable') }
  if (data?.schema_version !== 2 || !Array.isArray(data.models) || !data.models.length
    || typeof data.behaviors !== 'object' || !Array.isArray(data.review_providers)) {
    throw new Error('Update Caller: the model catalog is unavailable')
  }
  for (const row of data.models) {
    if (typeof row?.identity !== 'string' || typeof row.provider !== 'string') {
      throw new Error('Update Caller: the model catalog is unavailable')
    }
  }
  return data as Catalog
}

export async function loadCatalog(options: { fresh?: boolean } = {}): Promise<Catalog> {
  if (!options.fresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog
  if (pending) return pending
  pending = (async () => {
    try {
      const { stdout } = await runFile('agent-interface', ['--models'], {
        cwd: agentInterfaceCwd(),
        timeoutMs: CATALOG_PROBE_TIMEOUT_MS,
      })
      const catalog = parseCatalog(stdout)
      cached = { at: Date.now(), catalog }
      return catalog
    } finally {
      pending = null
    }
  })()
  return pending
}

export function catalogModel(catalog: Catalog, identity: string): CatalogModel | null {
  return catalog.models.find((m) => m.identity === identity) || null
}

export function isClaudeModel(catalog: Catalog | null, identity: string): boolean {
  const row = catalog ? catalogModel(catalog, identity) : null
  if (row) return row.provider === 'claude'
  return RETIRED_CLAUDE_PREFIXES.some((prefix) => identity.startsWith(prefix))
}

export function isReviewModel(catalog: Catalog, identity: string): boolean {
  const row = catalogModel(catalog, identity)
  return !!row && catalog.review_providers.includes(row.provider)
}

// Every place in Poise that launches a model, with the Caller behavior whose
// catalog default seeds it. `review` places may only use review providers and
// their fallback is the recovery model Caller switches to after a Claude
// output limit; for the others the fallback is used when the default cannot
// be launched — its provider is not signed in, or a refresh retired it.
export const MODEL_PLACES = [
  {
    key: 'chat',
    label: 'Chat',
    why: 'Card chats opened from Current, Archive and Swarm.',
    review: false,
    seed: 'author_content',
  },
  {
    key: 'editor',
    label: 'Editor chat',
    why: 'Document and annotation chats in the Editor. /content and /consensus use the Caller defaults listed below.',
    review: false,
    seed: 'author_content',
  },
  {
    key: 'pr_review',
    label: 'PR review',
    why: 'Automatic and manual reviews, including replays. The fallback takes over once if Claude hits its output limit.',
    review: true,
    seed: 'pr_review',
  },
  {
    key: 'pr_approve',
    label: 'PR approval',
    why: 'Automatic approvals and approval replays. The fallback takes over once if Claude hits its output limit.',
    review: true,
    seed: 'pr_approve',
  },
] as const

export type ModelPlace = typeof MODEL_PLACES[number]['key']
export const MODEL_PLACE_KEYS = MODEL_PLACES.map((p) => p.key) as ModelPlace[]

export interface ModelChoice {
  default: string
  fallback: string
}

export type ModelSettings = Partial<Record<ModelPlace, ModelChoice>>

export function isModelPlace(value: string): value is ModelPlace {
  return (MODEL_PLACE_KEYS as string[]).includes(value)
}

// Stored choices are validated against the catalog at save time; a later
// refresh can still retire one, so every read resolves again and says so.
export interface ResolvedChoice extends ModelChoice {
  notes: string[]
}

export function resolveChoice(catalog: Catalog, place: ModelPlace, stored: ModelChoice | undefined): ResolvedChoice {
  const spec = MODEL_PLACES.find((p) => p.key === place)!
  const seedDefault = catalog.behaviors[spec.seed]
  const seedFallback = catalog.behaviors.review_recovery
  const notes: string[] = []
  const usable = (identity: string | undefined) => !!identity && catalogModel(catalog, identity) !== null
    && (!spec.review || isReviewModel(catalog, identity))
  let chosen = stored?.default
  if (!usable(chosen)) {
    if (chosen) notes.push(`${chosen} is no longer in the catalog; using ${seedDefault}.`)
    chosen = seedDefault
  }
  let fallback = stored?.fallback
  if (!usable(fallback)) {
    if (fallback) notes.push(`${fallback} is no longer in the catalog; using ${seedFallback}.`)
    fallback = seedFallback
  }
  return { default: chosen!, fallback: fallback!, notes }
}

export function validateModelSettings(catalog: Catalog, models: unknown): ModelSettings {
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new Error('models must be an object of places')
  }
  const next: ModelSettings = {}
  for (const [place, value] of Object.entries(models as Record<string, unknown>)) {
    if (!isModelPlace(place)) throw new Error(`unknown model place ${place}`)
    const spec = MODEL_PLACES.find((p) => p.key === place)!
    const choice = value as Record<string, unknown>
    for (const field of ['default', 'fallback'] as const) {
      const identity = choice?.[field]
      if (typeof identity !== 'string' || !catalogModel(catalog, identity)) {
        throw new Error(`${spec.label} ${field} must be a model from the catalog`)
      }
      if (spec.review && !isReviewModel(catalog, identity)) {
        throw new Error(`${spec.label} ${field} must be a ${catalog.review_providers.join(' or ')} model`)
      }
    }
    if (choice.default === choice.fallback) {
      throw new Error(`${spec.label} fallback must differ from its default`)
    }
    next[place] = { default: choice.default as string, fallback: choice.fallback as string }
  }
  return next
}

// The daily refresh (scripts/refresh-models.mjs, launchd 07:00) leaves its
// last report here; the settings pane shows when the catalog was last checked.
export function catalogReportPath(): string {
  return process.env.POISE_MODEL_CATALOG_REPORT || join(homedir(), '.poise', 'model-catalog.json')
}

export async function readCatalogReport(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(catalogReportPath(), 'utf8'))
  } catch {
    return null
  }
}

export async function writeCatalogReport(report: Record<string, unknown>): Promise<void> {
  const path = catalogReportPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staged = `${path}.${process.pid}.tmp`
  await writeFile(staged, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(staged, path)
}
