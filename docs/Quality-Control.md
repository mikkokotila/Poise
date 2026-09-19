# Chat experience quality control

This round checks the combined Chat experience after the Memories release,
not only each feature in isolation. The release/merge policy is unchanged.

## Corrections

| Area | Correction and regression coverage |
| --- | --- |
| Text composition | Enter during input-method composition cannot send, steer, enqueue or commit a session rename. |
| Failed submissions | Rapid fresh messages released by one Memories save retain the second message instead of dropping it during session creation. Failed messages and steering retain their text alongside newer drafts; attachments and mentions are deduplicated rather than overwritten. Command chips restore without duplicating their prefix. |
| Refresh recovery | Update drafts are tab-local too, so another tab cannot consume them; marked legacy update snapshots can still migrate. Ordinary tab refresh retains the selected conversation, per-session drafts, the fresh model choice and pending question-form drafts. Restoration never submits a message or an answer. |
| Concurrent UI state | A late REST snapshot cannot replace newer streamed model, Auto-merge, status or queue state. Late history/fork/handoff completion does not steal focus from another conversation. |
| Inline questions | Highlighting another pending question no longer rebuilds a half-filled form. Navigation preserves answers; a typed alternative takes precedence over an earlier single-choice selection. |
| Model choice | Choosing a catalogue identity uses its effort, not the previous model's effort. Effort choices belong to the selected model family, and native restrictions from an old family are not applied to a new one. |
| Suggestions and dialogs | Escape dismisses delayed file suggestions without their reopening later. New session contains keyboard focus during loading and selection, ignores superseded load results, and returns focus to its opener. File preview and New session restore clicked opener focus in WebKit as well as Chromium/Firefox. |
| Side panes | The session pane accounts for the Memories pane's width while preserving its preferred size. Both panes leave room for the console; short-window queue tests retain the entire composer. |
| Stopping startup | Stop cancels a turn waiting for checkout access before its agent launches. Checkout and native worker cleanup remain verified. |
| Queue ownership | Later manual activity can take an idle delegated queue back into its original conversation without taking a running queued turn away. |
| Attached context | Poise-change commands carry uploaded files and mentions through both pasted and chip entry paths. Attachment-bearing retries are distinguished from different requests with the same words. |
| File lifetime | Receiving sessions get independently issued, hash-verified copies of attached context. Deleting a source or former executor preserves files borrowed by surviving waiting tasks, including older queues. |
| Shared Memories | A conflicting draft remains unsaved even when edited back to an obsolete baseline; it cannot silently send different saved context or lose its recovery copy. |
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


## Supplemental browser QC

The normal `npm run verify` and CI remain Chromium-based. This round also
runs the full Chat suite, real ACP queue journey and stream-latency checks
in Firefox and WebKit. Enable the supplemental projects explicitly:

```sh
npx playwright install firefox webkit
POISE_BROWSER_QC=1 npx playwright test tests/e2e/chat.spec.ts tests/e2e/chat-queue.spec.ts tests/e2e/chat-latency.spec.ts --project=firefox --project=webkit
```

The Copy test grants Chromium's clipboard permissions only on Chromium;
Firefox/WebKit exercise the same Copy button through a trusted user click.
Content, focus, scroll and injection-safety assertions are unchanged. These
are browser-engine checks, not a claim to have tested every browser/device.
The queue-recovery test additionally proves that a failed reconciliation
cannot start an armed queue; retrying successful recovery starts it once.
