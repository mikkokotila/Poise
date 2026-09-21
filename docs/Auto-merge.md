# Auto-merge mode

The Auto-merge icon in the Chat header toggles Auto-merge for
that Chat session. It is off by default. It is also available in the fresh
console before the first message or attachment, without opening a session.

When enabled, the selected agent owns the whole requested batch: implement
all slices, run the appropriate checks, fix failures and conflicts, open or
update PRs, wait for mergeability and required checks/reviews, merge, and
verify the merges. This applies to every repository involved in the request,
not only Poise, and does not stop at the first PR or at “ready to merge”.

The shared instructions emphasize continuing without interruptions. The agent
should investigate available information, make reasonable reversible choices,
and finish independent work rather than stall the batch on one blocked PR.
Only indispensable missing information warrants a mid-work question. Deferred
non-blocking questions, assumptions, merged PRs and genuinely blocked work
belong in one final report after all unblocked work is complete.

## Persistence and running work

The server stores the choice in the session record. Reloading or resuming
retains it; unrelated new sessions default off. Deliberate forks and handoffs
inherit the choice. A fresh-console choice is retained in the current tab
until its session is created.

A toggle during a turn sends the updated instructions through the native
steering channel, without creating another turn or a fake user message. If
that channel fails, the setting is retained for the next message and the UI
reports the failure. Turning it off cannot undo a merge already in progress;
Stop remains available for cancelling current work.

## Tool permissions and scope

Tool permissions are controlled independently by **Safe mode**, not by
Auto-merge. Safe mode is off by default: ordinary native approvals run without
prompting. Enabling Safe mode retains native risk approvals even while
Auto-merge is on. Changing Auto-merge never silently changes that choice.
Actual questions remain answerable and are not filled with fabricated answers.
See [Chat controls](Chat-controls.md).

This is an agent workflow, not a separate GitHub merger or a promise that
any model will complete every possible task. Normal credentials, native
capabilities, repository protections and required checks still apply. It
neither weakens those controls nor authorizes unrelated work. The agent is
instructed to verify outcomes and report blockers honestly.

## Relationship to Poise self-improvement

Ordinary messages in an Auto-merge session stay with that agent, including
multi-PR batches involving Poise. The optional explicit `/poise` command still
selects the independent one-change release/rollback controller. A change
already handed to that controller keeps its original handoff, rather than
having two actors race to merge it. General Auto-merge does not widen the
controller's repository identity, credentials or rollback guarantee.
