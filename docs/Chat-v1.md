# Chat v1

Chat is a Poise-native window onto the installed coding agents, not a new
agent harness and not an embedded terminal UI. Poise owns sessions, streaming
and interaction; Claude Code, Codex, Grok Build and Muse do the agent work
through their native session interfaces. The implementation follows issue #68.

## Scope and migration

Chat is a full view alongside Current, Swarm and Editor. Its sidebar stores
named sessions; the transcript renders streamed prose, thinking when exposed,
tool activity, file diffs, questions and permission cards. The composer supports
attachments, checkout-file mentions, advertised commands, draft preservation,
steering during a turn and Stop. Capabilities belong to each native session:
unsupported optional controls are not simulated.

Current cards, Swarm rows and Editor documents can hand off into Chat. Changing
the agent creates a new native session with a labelled context handoff, not a
pretence that one vendor's session migrated to another. The existing chat pane
remains for `/content`, `/consensus` and Editor annotations in v1. Its retirement
belongs to v1.1. Antigravity, pi, image input, worktrees and parallel turns on the
same checkout are outside v1.

## Sessions and working context

A session is bound to one repository checkout and one branch. The branch may
be new, existing or a pull request head. The runtime selects and verifies that
branch before starting the native agent. Switching away from a session-owned
dirty branch checkpoints tracked and untracked, non-ignored work with
`wip(poise): checkpoint`. Dirty branches without a session owner are refused,
not automatically committed or stashed. Branch removal is conservative: a
session must not delete committed or uncommitted work on its way out.

The checkout lease is shared by Poise development, Poise production and the
compatible Caller writing behavior. Turns in different checkouts can run
concurrently; another session on the same checkout is visibly queued. The
lease covers startup, execution, tool services and process cleanup, not only
the subprocess launch. Worker gates register a process group before allowing
it to run. An unverified surviving worker keeps the checkout blocked. A
Poise-side filesystem operation must finish before the lease is released;
killing an agent cannot cancel filesystem work already executing in Poise.

These are cooperative application locks. They do not prevent a person or an
unrelated program from modifying the checkout outside Poise. Native agents
also retain their own tool and sandbox policies; a working directory alone is
not an operating-system sandbox. See SECURITY.md for the trust boundary.

## Persistence and recovery

`server/chat/storage.ts` mirrors events with monotonically increasing sequence
numbers. Reading a transcript does not launch or wake an agent. Reconnecting
browsers replay the mirror from the last contiguous event received and then
rejoin live events. A future event cannot advance the watermark past a gap.

Mutating WebSocket commands have durable receipts, keyed by runtime instance
and request ID with a canonical command hash. Concurrent retries share one
execution; a changed payload under the same ID is rejected. Completed receipts
survive a server restart. A pending receipt whose outcome is no longer known
returns `command_in_doubt`: it is never permission to run the mutation again.
Inspect the session before deliberately submitting a new action. Receipts and
transcripts are local data and are retained rather than evicted in a way that
would make an old command executable again.

Server restart does not replay prompts. Open turns become interrupted and
pending interactions are cancelled, while sessions owned by another live host
are left alone. The terminal transcript event, immutable Caller outcome and
clearing of the open-turn marker commit in one SQLite transaction. Caller
finish failures remain in a durable outbox even if later turns run or the
session is deleted; recovery retries the actual recorded outcome. A failed
recording operation must not turn a completed turn into an invented failure.

Stop cancels the turn, not the session. Native cancellation is acknowledged
only when the adapter can account for its work. Claude messages are UUID-tracked
across native results so queued steering remains part of the same Poise turn.
If accepted messages cannot be accounted for, the process is ended and the
turn fails visibly rather than being labelled successful. A stopped Claude
session resumes its native ID on the next explicit action.

Muse steering can create a subsequent native turn. Stop accounts for every
accepted send: it reclaims queued turns through the native queue interface
or interrupts their exact IDs if launch won the race. Completion of the old
foreground turn alone is not proof that queued work has stopped. Missing
steering outcomes fail visibly, and a forced protocol close asks the runtime
to verify worker termination before releasing the checkout.

## Files, attachments and Editor

Poise's filesystem services validate checkout paths and perform bounded
reads and atomic writes. Uploads are session-owned, carry server-issued IDs
and are looked up again by the runtime. Browser-supplied inline file text is
not trusted as authoritative. Uploads and file operations participate in the
checkout lifecycle and cannot outlive release of their lease.

The existing Editor stores Markdown in its configured directory, normally
`~/.poise/editor`; it is not a repository browser. Chat therefore uses a
session-owned staged copy inside the checkout and version-checked writeback.
A concurrent Editor change preserves the conflict copy instead of overwriting
newer writing. Two sessions and their forks do not share mutable stage paths
or remove each other's preserved copies.

A diff is a record of an edit that already happened, not an approval request.
Revert checks that the current file still matches the recorded post-image
before restoring the pre-image. Unreadable or unverified pre-images must not
be treated as nonexistent files: doing so could delete existing work. Native
unified patches and complete file records are distinguished; the implementation
must not offer a destructive Revert for a patch it cannot safely reconstruct.
Provider-specific coverage limitations belong in the verification record,
not behind a simulated success state.

Poise also captures a bounded before/after checkout snapshot for each turn.
Its separate "Checkout changes during this turn" card records shell edits and
automatically approved writes that native tool events do not fully describe.
It is a whole-turn observation, not attribution to one native tool. The default
bounds are 20,000 file paths, 8 MiB per file and 64 MiB of captured content.
Ignored file contents are not copied unless explicitly needed for the session's
Editor stage. Their names are inventoried so a changed ignore rule cannot make
an old ignored file appear to be a newly created, safely deletable file.
Binary, oversized or unreadable changes produce explicit coverage warnings;
they are never offered as reversible from an invented pre-image.

Large recorded diffs use bounded previews over WebSocket and in history.
"Load complete diff" retrieves the immutable full record on demand; Revert
stays disabled until that record has loaded. The full record remains in SQLite
and the server checks it, not the browser preview, when reverting. This avoids
oversized events trapping a reconnect in the same failed replay repeatedly.

## Native interfaces and credentials

The adapters live under `server/chat/adapters/`:

| Agent | Interface | Version basis |
| --- | --- | --- |
| Grok Build | ACP over stdio JSON-RPC | installed Grok; captured protocol traces in tests/fixtures/chat |
| Claude Code | Claude Agent SDK through the subscription wrapper | SDK 0.3.274, written against Claude Code 2.1.274 |
| Codex | app-server over stdio JSON-RPC | generated types and version marker under generated/codex |
| Muse | MSP over stdio JSON-RPC | generated schema and version marker under generated/muse |

Adapters expose the native models, efforts and optional capabilities rather
than inventing substitutes. A protocol/version mismatch is a readable startup
error, not a silent downgrade. Settings supplies the default Chat model; a
fallback is an explicit user choice when the selected provider is unavailable.

Poise passes no provider key. Claude continues through the existing monitored
subscription wrapper and exact environment allowlist. The other agents use
their own installed login state. The wrapper does not change account-level
usage-credit settings, and live verification consumes the relevant account's
usage. Authentication/usage failures are not grounds to retry indefinitely or
silently switch to a billed API credential.

## Caller and release integration

Chat requires the companion Caller additions: `--record-turn start/finish`,
external `poise:chat` rows, and the shared checkout lease around writing work.
Caller records the ledger but launches no process for a Chat turn. Swarm's
Stop routes these rows back to ChatRuntime rather than to Caller's one-shot
process stopping path. Other behavior rows keep their existing semantics.

The companion implementation is developed separately from the user's live
Caller checkout. Before production promotion, publish a compatible Caller
revision through the normal managed release process and verify the tracked
release can record turns and cooperate on checkout locks. Do not point a
production service at an ad-hoc development clone to bypass release checks.
An older Caller produces an explicit compatibility error.

## Verification record — 2026-09-18

Run `npm run check` for lint, unit/integration tests, typechecks and production
build. Run `npm run test:e2e` for isolated Playwright fixtures, or `npm run verify`
for both. The browser suite covers the new view and the existing dashboard;
it is not evidence that a live provider honored an interaction.

Final validation on the implementation checkout:

| Check | Result |
| --- | --- |
| `npm run verify` | Passed: 607 unit/integration tests in 57 files, lint, all three typechecks, production client/server builds and 26 Playwright tests |
| Companion Caller Python suite | 215 tests passed in isolated data directories |
| Actual Poise TypeScript to companion Caller CLI | Recorded completed/cancelled turns; repeated start/finish deduplicated; no provider calls |
| `npm audit --omit=dev --audit-level=high` | Zero vulnerabilities reported |

The detailed local logs are retained under `/tmp/poise-chat-v1/`, notably
`final-verify.log`, `continue-caller-tests.log`, `caller-bridge-result.log` and
`production-dependency-audit.log`. Temporary evidence is not a substitute for
rerunning the checked-in regression suites after later source changes.

Independent regressions cover command replay, reconnect ordering, origin
checks, bounded socket shutdown, process descendants, shared leases, scoped
filesystem operations, atomic prompt reservation, permission scoping, Editor
conflicts, durable Caller finalization and rollback on an outbox write failure.
The companion Caller's Python suite and a real Poise-TypeScript-to-Caller-CLI
probe also verify recording without launching a provider.

Live checks use temporary repositories and databases, not production data.
The following is deliberately separate from fixture coverage:

| Agent | Live evidence recorded during implementation | Remaining qualification |
| --- | --- | --- |
| Grok | Native text, steering request, permission and question roundtrips, Stop, subsequent use and native-ID resume observed | Submit-to-first-token timing does not measure the provider-event-to-browser rendering requirement |
| Claude | Native startup/text, steering with the revised reply, an actual question answered B, permissions during a file write, Stop/subsequent use, native-ID resume with remembered context, and file creation/Revert observed | Native user hooks remain active; a fixture repository can trigger hook warnings. Not every model/effort combination was exercised |
| Muse | Text, steering, actual permission/question roundtrips, Stop/subsequent use and native-ID resume observed. Separate checks verified auto-approved file creation/diff/Revert and Stop with a queued steer | The queued-steer Stop observation was 211 ms, followed by a successful prompt; this is a measured instance, not a worst-case guarantee |
| Codex | Native interface/schema inspection and scripted app-server tests | Live turns were blocked by the account's usage limit; no repeated attempts or credential fallback were used |

Passing fixtures do not remove these qualifications. In particular, complete
live validation of all four agents and a measured browser streaming latency
requirement must not be inferred from a green build. Production was not
updated as part of these checks.
