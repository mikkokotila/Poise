import { claudeAuth } from './claude-auth'
import { REVIEW_POLICY, type Catalog, type ReviewerSlot, isClaudeModel, loadCatalog, placeProviders, resolveChoice, reviewerModels } from './models'
import { getModelSettings } from './settings'

export { REVIEW_POLICY }

export interface ReviewChoice {
  model: string
  recovery: string
  catalog: Catalog
}

export type ReviewPlace = 'pr_review' | 'pr_approve' | 'issue_review'

// Older Caller versions silently ignore --model on PR behaviors and know
// nothing of identities, and a Caller without --issue-review lists no issue
// review providers. Prove support before launching so the selected model can
// never silently become another one.
async function supportedCatalog(place: ReviewPlace): Promise<Catalog> {
  const catalog = await loadCatalog()
  if (place === 'issue_review') {
    if (!placeProviders(catalog, place)?.length) throw new Error('Update Caller: issue review is unavailable')
  } else if (catalog.policy !== REVIEW_POLICY) {
    throw new Error('Update Caller: PR review model selection is unavailable')
  }
  return catalog
}

export async function reviewChoice(place: ReviewPlace): Promise<ReviewChoice> {
  const catalog = await supportedCatalog(place)
  const choice = resolveChoice(catalog, place, getModelSettings()[place])
  return { model: choice.default, recovery: choice.fallback, catalog }
}

export interface ReviewPanel {
  reviewers: Array<{ slot: ReviewerSlot, model: string }>
  recovery: string
  catalog: Catalog
}

// The reviewers of a new pull request or issue, primary first: as many of
// the place's default, secondary and tertiary as Behaviors asks for.
export async function reviewPanel(count: number, place: 'pr_review' | 'issue_review' = 'pr_review'): Promise<ReviewPanel> {
  const catalog = await supportedCatalog(place)
  const choice = resolveChoice(catalog, place, getModelSettings()[place])
  return { reviewers: reviewerModels(choice, count), recovery: choice.fallback, catalog }
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
