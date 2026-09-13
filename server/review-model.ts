import { homedir } from 'node:os'
import { join } from 'node:path'
import { runFile } from './process'
import type { ReviewModel } from './settings'

// Older Caller versions silently ignore --model on PR behaviors. Prove support
// before launching so the selected model can never silently become another one.
export async function requireReviewModelSupport(model: ReviewModel): Promise<void> {
  const expected = { opus: 'opus-5-max', astra: 'gpt-6-astra-xhigh' }
  const { stdout } = await runFile('agent-interface', ['--review-models'], {
    cwd: process.env.AGENT_INTERFACE_ROOT || join(homedir(), 'dev', 'caller', 'agent_interface'),
    timeoutMs: 30_000,
  })
  let models: Record<string, unknown>
  try { models = JSON.parse(stdout) }
  catch { throw new Error('Update Caller: PR review model selection is unavailable') }
  if (!models || models[model] !== expected[model]) {
    throw new Error(`Update Caller: the selected PR review model ${model} is unavailable`)
  }
}
