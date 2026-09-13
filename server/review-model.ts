import { homedir } from 'node:os'
import { join } from 'node:path'
import { runFile } from './process'
import type { ReviewModel } from './settings'

// Older Caller versions silently ignore --model on PR behaviors. Prove support
// before launching so the selected model can never silently become another one.
export const REVIEW_POLICY = 'bounded-v1'
export const REVIEW_MODELS = { opus: 'opus-5-high', astra: 'gpt-6-astra-xhigh' } as const

export async function requireReviewModelSupport(model: ReviewModel): Promise<void> {
  const { stdout } = await runFile('agent-interface', ['--review-models'], {
    cwd: process.env.AGENT_INTERFACE_ROOT || join(homedir(), 'dev', 'caller', 'agent_interface'),
    timeoutMs: 30_000,
  })
  let models: Record<string, unknown>
  try { models = JSON.parse(stdout) }
  catch { throw new Error('Update Caller: PR review model selection is unavailable') }
  if (!models || models[model] !== REVIEW_MODELS[model] || models.policy !== REVIEW_POLICY) {
    throw new Error(`Update Caller: the selected PR review model ${model} is unavailable`)
  }
}
