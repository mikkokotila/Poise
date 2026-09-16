// Ask Caller to check every model family against its CLI and rewrite the
// runtime catalog when something changed. Claude and Muse answer with a short
// model turn each, so this takes a minute or two and runs once a day from
// launchd (scripts/refresh-models.mjs) or on demand from the settings pane.

import { agentInterfaceCwd } from './models'
import { claudeSubscriptionEnvironment, runFile } from './process'

const REFRESH_TIMEOUT_MS = 10 * 60_000

export async function refreshModelCatalog(): Promise<Record<string, unknown>> {
  const { stdout } = await runFile('agent-interface', ['--refresh-models'], {
    cwd: agentInterfaceCwd(),
    env: claudeSubscriptionEnvironment(),
    timeoutMs: REFRESH_TIMEOUT_MS,
  })
  let report: unknown
  try { report = JSON.parse(stdout) } catch { throw new Error('Update Caller: the model catalog refresh is unavailable') }
  if (typeof report !== 'object' || report === null || typeof (report as any).families !== 'object') {
    throw new Error('Update Caller: the model catalog refresh is unavailable')
  }
  return report as Record<string, unknown>
}
