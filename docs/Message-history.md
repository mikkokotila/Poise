# Console message history

With an empty console, press **Up** to open a selection list immediately
above the input. It shows up to ten acknowledged user messages from the
current conversation, one line each. Long rows end in an ellipsis; full text
and line breaks are retained for recall. The newest message is closest to
the console and selected initially.

**Up/Down** moves to older/newer messages. **Home/End** selects the oldest or
newest displayed row. **Enter** or a row click restores that message as an
editable draft; it does not send, steer, queue, or launch an agent. Send the
draft normally after reviewing or editing it. Holding Enter while recalling
cannot accidentally submit it through key repeat.

**Escape**, Down past the newest row, Tab, an outside click, or typing a new
message dismisses the list. Existing text, an active command chip or attached
files keep ordinary composer keyboard behavior; history does not replace
unfinished work. Input-method composition and modified arrows are unaffected.

History includes normal messages, acknowledged steering and dispatched queued
tasks. Recalled queued tasks retain the queue chip; attachment and mention
references stay with their original conversation. Model and Auto-merge choices
do not change. The usual message path supplies the latest Memories on send.
Agent output, generated initial handoff summaries and unacknowledged optimistic
requests are not recall candidates. Pending queue items remain in Queue.

The list reads the already loaded transcript, including restored history after
reload. It performs no writes, agent calls or new network requests. An open
list keeps a stable selection while output streams, closes on conversation
or view changes, and never executes recalled content by itself. An empty
conversation displays an empty state only when history is requested.

The pane shares available space with Queue above the console. On short windows
its rows scroll rather than hiding the input or Send button. Focus stays in
the textarea with an accessible active-descendant selection. Light/dark themes
and reduced-motion preferences are supported.

## Verification

`npm run verify` exercises the full regression suite. Focused browser cases:

```sh
npx playwright test tests/e2e/chat.spec.ts --grep 'history:'
POISE_BROWSER_QC=1 npx playwright test tests/e2e/chat.spec.ts --grep 'history:' --project=firefox --project=webkit
```

Unit coverage: `tests/chat-message-history.test.ts`. Browser tests cover the
ten-message limit, keyboard/mouse recall, exact multiline text, escaping,
attachments/queue semantics, empty/loading states, input composition,
streaming, reload/session isolation and combined Queue/Memories layouts.
