import { trackReleaseBackground } from './release-background'
// The scheduled job and manual check share CLI updates, discovery and receipts.
import { dirname, join } from 'node:path'
import { agentInterfaceCwd, catalogReportPath, invalidateCatalog } from './models'
import { CLAUDE_SUBSCRIPTION_CLI, claudeSubscriptionEnvironment, runFile, scrubbedChildEnvironment } from './process'

let pending: Promise<Record<string, unknown>> | null = null
export function refreshModelCatalog(): Promise<Record<string, unknown>> {
  if (pending) return pending
  const finished = trackReleaseBackground()
  pending = (async () => {
    let stdout: string
    try { ({ stdout } = await runFile(process.execPath, [join(dirname(CLAUDE_SUBSCRIPTION_CLI), 'refresh-models.mjs'), '--json'], {
      cwd: agentInterfaceCwd(),
      env: { ...scrubbedChildEnvironment('agent-interface', claudeSubscriptionEnvironment()), POISE_MODEL_CATALOG_REPORT: catalogReportPath() },
      timeoutMs: 15 * 60_000, killSignal: 'SIGTERM',
    })) } catch (error) {
      // The script emits a durable structured failure even on a nonzero exit.
      // Return that diagnostic, not just the Node process's exit code.
      const output = (error as { stdout?: unknown }).stdout
      if (typeof output !== 'string' || !output.trim()) throw error
      stdout = output
    }
    let report: unknown
    try { report = JSON.parse(stdout) } catch { throw new Error('The model check returned an unreadable report') }
    if (!report || typeof report !== 'object' || !('families' in report) || !report.families || typeof report.families !== 'object' || Array.isArray(report.families)) throw new Error('The model check returned an invalid report')
    return report as Record<string, unknown>
  })().finally(() => { invalidateCatalog(); pending = null; finished() })
  return pending
}
