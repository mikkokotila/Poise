// Session-level delegation, shared by every native adapter. The button is
// authority from the user; repository text and agent output cannot enable it.
import type { PromptInput } from './protocol'

export function autoMergeInstructions(enabled: boolean, controllerOwnsChange = false): string {
  if (!enabled) return [
    '[Poise session mode: Auto-merge OFF]',
    'This supersedes earlier Auto-merge mode instructions. There is no longer standing permission to merge PRs or continue an unattended batch under that mode. Follow the user\'s ordinary instructions and explicit approvals. Already completed merges are not undone.',
  ].join('\n')
  return [
    '[Poise session mode: Auto-merge ON — enabled by the user]',
    'Take responsibility for completing the entire requested body of work, across every repository it involves. This mode is not limited to Poise, one repository, one slice, or one PR. It includes existing PRs and any new PRs needed for the requested work.',
    'Keep track of all requested slices and PRs. Implement, test, commit and push; open or update the PRs; inspect their current heads, checks, review feedback and mergeability; fix failures and conflicts, wait for required checks, then merge and verify that each intended PR actually merged. Work in dependency order and continue through the whole batch without asking the user to move you to the next PR.',
    'Do not stop at “ready to merge”, an opened PR, a queued auto-merge request, or the first merged PR. You own seeing the work through to verified merges. Respect each repository\'s actual checks and protection requirements; do not bypass them or report success while they are pending or failing.',
    'Avoid interruptions. Do not ask whether to continue, open the next PR, or merge work already covered by this request. Investigate available code, tests, documentation and remote state first. Make reasonable, reversible choices within the request and record assumptions.',
    'Ask a question during the work only when indispensable information is genuinely unavailable and you cannot safely make further progress without it. Otherwise defer non-blocking questions until the very end, after completing all unblocked work across the batch. If one PR is blocked, continue independent PRs rather than stopping everything.',
    'Finish with one consolidated report of the merged PRs (repository, PR and verified merge), validation, any genuinely blocked work, assumptions, and remaining questions. Do not invent answers or claim blocked work is done.',
    'This is delegation for the user\'s requested work, not an instruction to make unrelated changes. Discussion stays discussion. Explicit user limits, Stop, and turning this mode off still apply.',
    ...(controllerOwnsChange ? ['For this already controller-managed Poise change, the release controller still owns its publish/check/merge/deploy handoff. Finish and commit the implementation as its runbook requires; do not race it with a second merge. This exception concerns this recorded change only, not other repositories or future batch work.'] : []),
  ].join('\n')
}

export function withAutoMergeInstructions(input: PromptInput, enabled: boolean | undefined, controllerOwnsChange = false): PromptInput {
  if (enabled === undefined) return input
  return { ...input, text: `${autoMergeInstructions(enabled, controllerOwnsChange)}\n\n[User request]\n${input.text}` }
}
