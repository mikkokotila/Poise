# Queued Chat messages

Use `/queue <message>` to save a follow-up instead of sending it immediately.
The command is also available as a composer chip: type `/queue` and Space,
then write the message. Enter or the Queue message button adds the item.
The switch works during a turn and in an idle or fresh conversation. It never
steers or stops the active turn, and adding to an idle queue never starts work.

## A typical sequence

Add five follow-ups with `/queue`, then send the task that should happen first
as a normal message. That task runs immediately. When it completes, the five
queued messages run in insertion order, one turn at a time. When the queue
empties it hides itself. Adding another item while idle waits for another
completed task; it does not reuse an old completion signal.

The Queue section sits directly above the console. It opens when the first
item is added, and can be collapsed without losing anything. Streaming does
not reopen it. Each row shows its text, attachments, status, and an agent/model/
effort selector populated from the catalogue. Change waiting rows independently
or remove them with the row's remove icon. Running rows remain labelled but
cannot be edited; use the normal Stop control to stop the active turn.

## Agents and context

Each item initially records the current model and effort. Selecting another
agent on a row does not change the agent working now. At dispatch Poise starts
that actual native adapter, keeps the same Poise transcript and workspace, and
provides a labelled summary of preceding work. It does not pretend that one
provider's native conversation was transferred to another. The transcript
labels dispatched tasks with From queue and their agent/model.

Queueing a fresh conversation creates idle session storage only: no native
agent starts until you send the initial task. Attachments retain their checked
server-issued identity and are read when the queued task runs. The session's
Auto-merge setting applies to queued tasks in the same way as ordinary turns.
Unavailable providers remain visible in the selector but cannot be chosen.

If the initial task enters Poise's isolated change-and-deploy workflow, the
queue follows that conversation into its dedicated session. Follow-ups wait
until the release controller finishes using the checkout, then continue
automatically. No extra merge confirmation is introduced.

## Persistence and interruption

The server owns scheduling, not a browser event handler. Closing a tab,
switching sessions, or reloading does not discard or duplicate saved tasks.
Adding an item, claiming it, and recording its terminal outcome use durable
SQLite transactions and stable request IDs. A lost acknowledgement can be
retried with the same identity, including after a task completed or was removed.

A successful completed turn advances the queue. Pending permissions/questions
are still part of the current turn. Stop, a failed turn, or a crash pauses the
tail rather than silently treating interruption as success. The interrupted
item remains visibly not completed and is not automatically retried; remaining
waiting items proceed after the next successful task you send. Restart recovery
continues an already-armed but not-yet-started task, never an uncertain in-flight
one. Queues are not copied into independent forks.

## Verification

`tests/chat/message-queue-runtime.test.ts` exercises the runtime and SQLite
with all four scripted adapters. `tests/chat-queue-client.test.ts` covers the
switch, lost-acknowledgement identity, malformed responses and unavailable
browser storage. Transport regressions use real WebSockets.

`tests/e2e/chat.spec.ts` covers the controls, row choices, collapse state,
errors and session isolation. `tests/e2e/chat-queue.spec.ts` exercises five
idle items through real ACP stdio, the production runtime, SQLite, WebSockets
and browser rendering, with reloads before and during execution. Its native
process is a scripted fixture, not a live provider. No production conversation
or actual provider task is created by these tests.
