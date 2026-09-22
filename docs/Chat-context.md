# Chat context controls

## `/compact`

Type `/compact`, select its command chip, and send it to compact the current
agent's conversation context. The visible Poise transcript stays in place.
This uses the provider's native compaction, not a request for an ordinary
summary response. A fresh conversation with no native history reports that
there is nothing to compact and starts no model.

Claude and Grok receive their advertised native `/compact` command. Codex uses
`thread/compact/start`; Muse uses `session/compact`. An asynchronous command
acknowledgement is not completion: Poise waits for the native result/compaction
boundary. Failures, no-ops and unconfirmed completion are not presented as a
successful reduction in context. Stop remains available; a missing terminal
signal has a bounded deadline and the runtime verifies process shutdown.

During active work, `/compact` goes into the normal queue and waits for the turn
to finish. Messages entered while compaction is running also queue instead of
being injected into the compactor. A failed or stopped compaction pauses the
remaining queue, just like another failed/stopped task.

Switches compose as usual. `/compact /review` compacts first, then critically
reviews the latest actual assistant reply. `/model` can precede the command;
selecting a different provider still performs the usual handoff, so a newly
selected provider may have no native context left to compact. Text following
context switches is a task to run afterward, not an extra confirmation.

## `/reset`

Send `/reset` to clear conversation history **in the same chat**. There is no
confirmation dialog. A running turn is stopped first, and Poise verifies that
its native process has settled before clearing history. The next message starts
a new native session: no resume ID, handoff summary, previous reply or initial
conversation context is supplied. This also works from failed/interrupted chats
without trying to resume a damaged native log.

The chat's identity/title, selected model/effort, work mode, Safe mode and
Auto-merge preference stay in place. Workspace files and shared Memories are
not erased. "Fresh context" means no previous conversation; system/tool
instructions, repository instructions and explicit shared Memories still apply.
This is not secure deletion of provider logs, project files or disk backups.

An immediate reset pauses but retains explicitly queued future tasks. Send a
new initial task to start those tasks afterward. `/queue /reset` instead resets
at its place in the queue, then the following queued task gets fresh context.
`/reset New task` resets and then submits that task. A failed reset retains the
old history and unsent draft. A lost acknowledgement never causes an automatic
repeat of an already recorded reset.

Reset takes precedence over compaction when both occur in a chain. `/reset
/review` cannot review an erased reply and is rejected before history changes;
review before resetting, or supply a new task after reset.

## Reliability and verification

Reset and its new sequence barrier commit in one SQLite transaction. Sequence
numbers never rewind. Other tabs, reconnects and delayed history responses
cannot resurrect old messages; command receipts prevent duplicate execution.
Queue intentions, file records and Caller settlement records are independent.
Tests cover native completion rather than admission, failure/Stop/no-op,
multiple providers, reset/restart, queue boundaries, draft preservation and the
real browser-to-ACP/SQLite/WebSocket path. Provider processes are scripted in
those tests; they do not contact live models or modify production sessions.
