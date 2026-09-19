# Chat memories

The Memories icon is the rightmost Chat header control, after Auto-merge.
It opens a right-hand free-text pane, including before a session exists.
The pane animates open and closed, respects reduced motion, and becomes an
overlay in narrow windows. Hiding it does not disable memories.

The text is shared across Chat sessions and agents in this Poise installation.
Edits save automatically. The same Poise database that holds Chat history keeps
the text, so it survives a reload, restart and application release. It is not
committed into any repository. Clearing the text stops appending it to future
messages; it does not delete context already sent to a native conversation.

## Message assembly

The runtime reads the current saved text immediately before each native
prompt or steering message. Queued tasks read it when dispatched, not when
queued. First messages, subsequent messages, native handoffs, slash-command
prompts, Poise implementation runbooks and Auto-merge updates use the same
path. Existing card/Editor discussion prompts also append the saved text.

Each native adapter serializes memories last: after the message, runbook,
handoff summary, file mentions and attachments. The final text is prefixed
with `[Memories]`, followed by the user's text verbatim, including whitespace
and Unicode. No extra closing tag or instruction follows it. Empty or
whitespace-only text adds nothing. Structured protocol commands and answer
selections retain their schema; memories do not fabricate answers or turn
permission responses into unsolicited agent turns.

## Saving and recovery

GET/PUT `/api/chat/memories` use the existing local, same-origin API boundary.
Saves compare revisions in one SQLite transaction. A stale tab cannot overwrite
another tab's edit silently; its draft remains available for an explicit retry.
Repeated saves of the same text are idempotent. Text is limited to 64 KiB of
UTF-8 with an explicit error, never silent truncation.

The browser serializes autosaves and waits for pending memory edits before
sending a message. A failed save keeps both the memory draft and the submitted
message. Unsaved text and in-flight saves block automatic release reloads,
even when the pane is closed. Local recovery drafts are kept in session storage
when available. A saved textarea updates the reload guard's baseline.

Memories are additional user context, not an authorization channel: the
original typed request still decides Poise change routing, queueing, and
Auto-merge controls. The browser cannot forge the runtime-only prompt appendix.
Memories are sent to whichever native provider handles the message; do not put
credentials or text inappropriate for those providers in this shared area.

## Verification

Tests cover database persistence, revision conflicts, exact text preservation,
clearing, autosave races and failed-save recovery. Native-process tests inspect
the final Claude, Codex, Grok and Muse wire content after attachments/mentions.
Runtime tests cover queued tasks, steering, Auto-merge, handoff and Poise
runbooks. The real browser/ACP/SQLite queue journey verifies the final memory
block in the first task and all five queued turns. No live provider is needed.
