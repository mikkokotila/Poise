# Chat v1

Chat is a Poise-native window onto the installed coding agents, not a new
agent harness and not an embedded terminal UI. Poise owns sessions, streaming
and interaction; Claude Code, Codex, Grok Build and Muse do the agent work
through their native session interfaces. The implementation follows issue #68,
with the new-session policy below superseding its repository-picker design.

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
belongs to v1.1. Antigravity models remain visible in the catalogue, but native
Chat launches need a permission/question channel its current CLI does not offer.
pi, image input, worktrees and parallel turns on the same checkout are outside v1.

## Fresh console and split pane

The empty console is writable without selecting or creating a session first.
Its first send creates one Poise-local session using the current catalogue's
`opus-5-high` identity and sends the message to it. Clicking, focusing or typing
alone does not launch an agent. Attaching a file can lazily create the same
kind of session; the text and uploaded file stay together. The New session
dialog remains the explicit way to choose another model and effort.

If Opus 5 High is absent or unavailable, the draft is retained and the reason
is shown. There is no silent fallback. Session-creation and first-send errors
preserve the message, and repeated submission while creating cannot launch
another session. The console also returns to this writable state after the
last session is deleted. A selected session still starting its native agent
accepts a prompt through the runtime's existing serialized turn queue.

The sessions pane resizes from its right edge, remembers its width, and eases
open/closed without detaching its contents. Arrow keys resize the focused
separator, Home/End choose the bounds, and double-click resets the width.
Collapsed contents are inert; reduced-motion preferences suppress movement.
The fresh console has a 640 px maximum width, a taller writing area and a
slightly elevated position. Its border uses a low-opacity neutral hairline,
with no resting or focus shadow, in both light and dark themes.

## Sessions and working context

New session offers **Model** and **Effort**, with model families grouped across
all five catalogue providers: Claude, Codex, Grok, Antigravity and Muse. Efforts
come from the selected model's catalogue rows, not a provider-wide union. The
submitted identity always matches that effort. An unavailable provider stays
visible with its reason; Poise does not invent interactive capabilities or
silently choose a different model.

New sessions use `.poise-chat/workspace/` inside the running Poise installation.
The root `/.poise-chat/` ignore rule keeps workspace files out of Poise commits.
An independently initialized, remote-free Git repository inside that directory
provides checkpoints and safe Revert without switching or committing the outer
Poise checkout. The session branch is an internal implementation detail. The
dialog contains no repository, branch, PR, or location picker, and both REST and
WebSocket creation routes discard such fields. Card/document handoffs supply
context, not permission to check out another repository.

Existing repository-bound sessions and their transcripts remain intact. They
still use their original checkout and branch; this change does not move files
or rewrite their history. Transcript metadata continues in Poise's existing
SQLite store. Legacy session switching checkpoints owned dirty branches as
`wip(poise): checkpoint` and refuses unowned dirty work. A new local session
never stashes, commits, or switches the enclosing Poise source checkout.

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
| `npm run verify` | Passed: 617 unit/integration tests in 59 files, lint, all three typechecks, production client/server builds and 28 Playwright tests |
| Companion Caller Python suite | 299 installed-package tests passed across all three packages, with isolated data |
| Actual Poise TypeScript to companion Caller CLI | Recorded completed/cancelled turns; repeated start/finish deduplicated; no provider calls |
| `npm audit --omit=dev --audit-level=high` | Zero vulnerabilities reported |

The detailed local logs are retained under `/tmp/poise-chat-v1/`, notably
`pr-final-verify.log`, `caller-ci-local.log`, `caller-bridge-result.log` and
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
| Grok | Native text, steering request, permission and question roundtrips, Stop, subsequent use and native-ID resume observed | A separate real-browser probe measured 72 ms from native stdout to paint; see the PR follow-up below |
| Claude | Native startup/text, steering with the revised reply, an actual question answered B, permissions during a file write, Stop/subsequent use, native-ID resume with remembered context, and file creation/Revert observed | Native user hooks remain active; a fixture repository can trigger hook warnings. Not every model/effort combination was exercised |
| Muse | Text, steering, actual permission/question roundtrips, Stop/subsequent use and native-ID resume observed. Separate checks verified auto-approved file creation/diff/Revert and Stop with a queued steer | The queued-steer Stop observation was 211 ms, followed by a successful prompt; this is a measured instance, not a worst-case guarantee |
| Codex | Native interface/schema inspection and scripted app-server tests | Live turns were blocked by the account's usage limit; no repeated attempts or credential fallback were used |

Passing fixtures do not remove these qualifications. Complete live validation
of Codex is still blocked by quota, and the latency observations below are
not universal worst-case guarantees. These validation runs did not change
production services or data.


## PR verification follow-up — 2026-09-18

`tests/e2e/chat-latency.spec.ts` now measures the complete rendering path:
separate ACP process -> real Grok adapter -> ChatRuntime/SQLite -> real
WebSocket -> the built Chat view in Chromium -> a rendering opportunity.
The default test uses a deterministic, timestamped ACP process and makes no
provider calls. Eight streamed samples measured 18–29 ms across the local runs on the development
machine; the test requires every sample to render within 1,000 ms. Reload
also verifies transcript restoration without launching another agent.

An explicit `POISE_CHAT_LATENCY_LIVE=grok` run substitutes the installed Grok
executable, using temporary checkout/database state and one harmless prompt.
That observed first native text frame reached browser paint in 72 ms. This
is an observed native-stdout-to-paint measurement, not an assertion about
provider generation time or every future load condition. The test attaches
its JSON timing record to the Playwright results.

The initial Poise PR passed Linux CI on Node 20, 22 and 24. Caller CI exposed
an installed-package versus source-test gate-path mismatch and bounded `ps`
output on Linux. The fix tests the gate shipped with the imported package
and requests an untruncated process command; the installed-package local
suite passed 299 tests, including the independent identity checks.

## Local-session catalogue follow-up

The simplified new-session dialog and fixed Poise-local workspace passed
`npm run verify`: 617 unit/integration tests, all static/build gates and 28
Playwright tests. Coverage includes every catalogue provider and model-specific
effort, preserving the outer checkout and dirty work, queueing local sessions,
rejecting symlinked storage, retaining an unsettled bootstrap lease, and stripping
repository/branch/path inputs at both public creation endpoints.
The local log is `/tmp/poise-local-catalogue-final-verify.log`.
