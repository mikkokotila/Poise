# Chat integration QC — 2026-09-21

## Scope and method

Reviewed the recent Chat work through merged PR #82, starting from `c79547b`:
local sessions and the catalogue, native adapters and permissions, Auto-merge,
queued messages, Memories, message history, command chains and reply review,
file context, browser restoration, and the self-update/rollback boundary.
The existing full baseline passed: 1,072 unit/integration tests and 129 Chromium
browser tests. Passing that baseline did not establish coverage of the races
below. New regressions deliberately hold acknowledgements, native startup,
filesystem admission, and native responses, and inject SQLite receipt failures.

All fixes belong to one follow-up PR. No production session or release is changed
by the QC runs. The existing permission defaults, explicit merge authority,
release checks, queue scheduling, and no-replay guarantees remain unchanged.

## Findings and fixes

### Decisions remain answerable after a recording failure

Permission/question responses used to remove their native waiter before writing
the durable decision. A failed write left neither a delivered answer nor a live
request to answer again. The record now commits before the waiter is removed.
Tests fail the receipt insert, verify the request remains pending, restore the
database, and answer that same request once. Remembered permissions also retain
their decision kind: a missing or reused native option ID cannot turn a remembered
refusal into an approval. These cases were reproduced against the baseline.

### Startup and work modes use the acknowledged choice

A permission toggle during the native handshake could be saved yet miss the
first task. Before dispatch, the runtime settles pending control updates and,
when necessary, replaces the old-policy process while retaining its checkout
lease. Real gated-worker tests also keep a second writer blocked when worker
termination cannot be verified. No extra user prompt is created. The existing mid-turn deferred-mode
notice still applies after native work has actually begun.

Changing providers cleared capability metadata, which incorrectly prevented an
immediate `/mode plan` even when the new provider supported it. Capabilities are
now read from the initialized adapter. An explicitly saved Claude Plan mode is
also supplied on native resume, rather than silently returning to Build.

### Settings and queued work cannot overtake one another

Header model/effort changes now share the acknowledgement ordering used by
`/model`. Work-mode changes use that ordering too. A following message or queue
item waits for the selection to succeed; on failure, its draft remains unsent.
A recalled queued review retains its original reviewer/model/effort instead of
inheriting whichever agent happens to be selected now.

### Filesystem admission is part of the protected operation

The asynchronous branch check used to run before the service was counted.
A native turn could end and release its checkout while that check was pending,
after which the file operation could still execute. Admission is counted before
its first await, and its turn/lease state is rechecked before file access.
The regression holds that check, ends the native turn, and verifies that the
checkout remains busy and no late file is written.

### Steering carries the context that the composer shows

Sending a message during a turn previously discarded attached files and file
mentions before reaching the native adapter. Steering now validates the same
server-owned attachment references as ordinary messages, reads them while the
checkout is held, and supplies text/path context before the final Memories
appendix. Attachment-only steering also works. Failed sends restore the complete
draft alongside newer text; successful sends clear the submitted chips.
The transcript and recalled history retain independently copied file references.

### A late Muse answer cannot stop another turn

A delayed question-answer failure used the then-current turn when reporting its
error. Cancelling the original turn and starting another could therefore stop
the new work. Question delivery and failures are now tied to their originating
native turn. A scripted protocol regression reproduces that sequence.

### An update preserves Chat even before the view opens

Refreshing from Current/Editor before Chat mounted replaced the saved Chat draft
snapshot with an empty one. The update watch now preserves the existing valid,
tab-local snapshot until Chat consumes it. A real release-bundle browser test
refreshes from another view, then opens Chat and verifies the message, command
chip and selected model remain intact without submitting anything.

## Reproducing verification

Use the supported Node version matching the checkout's native dependencies.
The local Mac checkout uses Node 22. Run `npm run verify` for lint, unit and
integration tests, all TypeScript checks, production builds and Chromium tests.
The exact pushed revision and final results are recorded in the PR description.

For the supplemental browser pass:

```sh
for browser in firefox webkit; do
  POISE_BROWSER_QC=1 npx playwright test \
    tests/e2e/chat.spec.ts tests/e2e/chat-queue.spec.ts \
    tests/e2e/chat-latency.spec.ts tests/e2e/self-update.spec.ts \
    --project="$browser"
done
```

The real process/SQLite/WebSocket browser journey now exercises a five-item
queue, model-selected critical review, attached steering, Memories-last ordering,
and reload without duplicate work. Provider processes are scripted: this is not
a claim of fresh live-provider acceptance or production deployment. Existing
release tests continue to exercise health-verified promotion, failed-start
restoration, offline rollback and source reconciliation.
