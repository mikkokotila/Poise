import { claudeAuth } from './claude-auth'
import { REVIEW_POLICY, type Catalog, isClaudeModel, loadCatalog, resolveChoice } from './models'
import { getModelSettings } from './settings'

export { REVIEW_POLICY }

export interface ReviewChoice {
  model: string
  recovery: string
  catalog: Catalog
}

// Older Caller versions silently ignore --model on PR behaviors and know
// nothing of identities. Prove support before launching so the selected model
// can never silently become another one.
export async function reviewChoice(place: 'pr_review' | 'pr_approve'): Promise<ReviewChoice> {
  const catalog = await loadCatalog()
  if (catalog.policy !== REVIEW_POLICY) throw new Error('Update Caller: PR review model selection is unavailable')
  const choice = resolveChoice(catalog, place, getModelSettings()[place])
  return { model: choice.default, recovery: choice.fallback, catalog }
}

// Whether launching this identity needs the Claude.ai sign-in Poise monitors.
export function needsClaude(catalog: Catalog | null, identity: string): boolean {
  return isClaudeModel(catalog, identity)
}

// Fallback for non-review places: when the default is a Claude model and the
// sign-in is not ready, a fallback on another provider still launches.
export function launchable(catalog: Catalog, requested: string | undefined, choice: { default: string, fallback: string }): string {
  const wanted = requested || choice.default
  if (isClaudeModel(catalog, wanted) && claudeAuth.snapshot().status !== 'authenticated' && !isClaudeModel(catalog, choice.fallback)) {
    return choice.fallback
  }
  return wanted
}
