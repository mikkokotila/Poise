# Chat experience quality control

This round checks the combined Chat experience after the Memories release,
not only each feature in isolation. The release/merge policy is unchanged.

## Corrections

| Area | Correction and regression coverage |
| --- | --- |
| Text composition | Enter during input-method composition cannot send, steer, enqueue or commit a session rename. |
| Failed submissions | Failed messages and steering retain their text alongside newer drafts; attachments and mentions are deduplicated rather than overwritten. Command chips restore without duplicating their prefix. |
| Refresh recovery | Ordinary tab refresh retains the selected conversation, per-session drafts, the fresh model choice and pending question-form drafts. Restoration never submits a message or an answer. |
| Concurrent UI state | A late REST snapshot cannot replace newer streamed model, Auto-merge, status or queue state. Late history/fork/handoff completion does not steal focus from another conversation. |
| Inline questions | Highlighting another pending question no longer rebuilds a half-filled form. Navigation preserves answers; a typed alternative takes precedence over an earlier single-choice selection. |
| Model choice | Choosing a catalogue identity uses its effort, not the previous model's effort. Effort choices belong to the selected model family, and native restrictions from an old family are not applied to a new one. |
| Suggestions and dialogs | Escape dismisses delayed file suggestions without their reopening later. New session supports Escape and restores focus to its opener. |
| Side panes | The session pane accounts for the Memories pane's width while preserving its preferred size. Both panes leave room for the console; short-window queue tests retain the entire composer. |
| Stopping startup | Stop cancels a turn waiting for checkout access before its agent launches. Checkout and native worker cleanup remain verified. |
| Queue ownership | Later manual activity can take an idle delegated queue back into its original conversation without taking a running queued turn away. |
| Attached context | Poise-change commands carry uploaded files and mentions through both pasted and chip entry paths. Attachment-bearing retries are distinguished from different requests with the same words. |
| File lifetime | Receiving sessions get independently issued, hash-verified copies of attached context. Deleting a source or former executor preserves files borrowed by surviving waiting tasks, including older queues. |
| Auto-merge opt-out | Turning Auto-merge off does not depend on saving Memories successfully. Turning it on and sending work still flush pending edits. |

Browser draft recovery uses tab-local storage and is best-effort when browser
storage is unavailable. It is not an automatic retry mechanism. Server queue
claims, terminal receipts, permission boundaries and release checks remain
independent of browser state.

## Verification scope

`npm run verify` runs lint, the complete unit/integration suite, all TypeScript
checks, both production builds and the Chromium browser suite. Existing gates
continue to cover Current, Swarm, Editor, Settings, file previews, all four
native adapters, permission handling, shared checkout leases, crash recovery,
release staging, safe tab updates and model-independent rollback.

The added QC cases reproduce asynchronous failures and overlapping human
interactions. The mixed-surface browser case renders a transcript, a queue
using different agents, Auto-merge and Memories together in both themes.
The wide-sidebar case waits for the pane animation before checking usable
conversation width. The real queue journey runs through ACP process I/O,
SQLite, WebSockets and reloads instead of having the browser simulate dispatch.

Two fixture-readiness assumptions were corrected: git/SQLite fixture startup
has a bounded eight-second readiness deadline under concurrent suite load;
and the real queue browser test explicitly selects its existing fixture
conversation before typing, rather than confusing a writable fresh console
with a fully loaded session. The separate one-second rendering-latency
assertion is unchanged.

The PR records exact-head verification results. Scripted native protocol
coverage is not a claim that every live provider/account was exercised.
Production activation, real repository merges and production rollback are
not performed by these tests.
