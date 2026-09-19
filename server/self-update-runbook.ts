// The one instruction text every agent gets for a `/poise` change, whatever
// model runs it. It states what the controller will verify on its own so the
// agent's claims are never what gets released: the checkout, the branch, the
// allowed paths, the check command and the commit are the whole handover.

const REQUEST_CHARS = 64 * 1024

export interface RunbookInput {
  request: string
  branch: string
  baseSha: string
  workspace: string
}

/** What an automatic change may not touch: the machinery that judges and
 *  ships changes, and anything whose failure is not undone by a rollback.
 *  Everything else in Poise — front end and back end alike — is ordinary work. */
export const POISE_CHANGE_PROTECTED = [
  'the self-update release/rollback controller and its validation or authorization machinery (scripts/self-update/**, the bridge, drain/readiness/release routes, launch and install scripts)',
  'credentials, tokens, key files and how they are read or checked',
  'destructive data migrations (dropping or rewriting stored user data)',
  'external-package release configuration (publishing, registries, CI release workflows)',
] as const

/** The exact first prompt of a change session: the runbook, then the
 *  person's request verbatim. */
export function poiseChangePrompt(input: RunbookInput): string {
  const request = input.request.length > REQUEST_CHARS ? `${input.request.slice(0, REQUEST_CHARS)}…` : input.request
  return [
    '[Poise self-improvement change]',
    `You are implementing one change to Poise (mikkokotila/Poise) in a checkout the release controller prepared for it: ${input.workspace}`,
    `Work on the branch that is already checked out, ${input.branch} (based on ${input.baseSha}). Never switch, rebase, reset or rename it, and never touch any other checkout or repository.`,
    '',
    'Do exactly this, in order:',
    '1. Implement the request below as an ordinary Poise improvement — front end (src/), server (server/), tests, docs, whatever the request needs. Keep the change to what was asked.',
    `2. Leave these alone; a request that needs them is not automatic and must stop with an explanation instead: ${POISE_CHANGE_PROTECTED.map((p) => `\n   - ${p}`).join('')}`,
    '3. Add or update tests that cover the change.',
    '4. Run `npm run check` and make it pass (lint, unit tests, build). Fix what it finds; do not skip, weaken or delete existing tests.',
    '5. Commit everything on this branch with a clear message. Leave the working tree clean: unstaged or uncommitted work is not part of the change.',
    '',
    'Do NOT push, open a pull request, merge, tag, deploy, restart Poise or ask for any of that: the controller pushes the exact commit you leave, opens the PR, waits for CI, merges and releases it, and verifies each of those itself. Anything you claim about tests or the branch is not used; only the checkout is.',
    'If the request cannot be done within these limits, do not work around them: leave the tree clean, make no commit, and say why in one paragraph.',
    'Finish with a short summary of what changed and how it was tested.',
    '',
    'Request:',
    request,
  ].join('\n')
}

/** A short session title from the request's first line. */
export function poiseChangeTitle(request: string, max = 60): string {
  const line = request.split('\n').map(s => s.trim()).find(Boolean) || 'Poise change'
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
