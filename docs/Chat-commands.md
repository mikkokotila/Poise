# Model selection, command chains and reply review

Type `/model` in Chat to open a searchable catalogue immediately above the
console, in the same extension area as message history. Each row names its
provider, model and effort. Unavailable integrations remain visible but cannot
be selected. Use Up/Down or Home/End, then Enter/Tab, or click a row. Escape,
leaving the console or changing conversations dismisses the picker. A delayed
catalogue response never reopens a dismissed list.

Selection adds a model chip to the draft. It does not start an agent, run a
command or change an ongoing turn. Continue typing the task or another switch;
Send applies the selected model to that task. Sending the model chip alone
changes the conversation's model without starting a task. In a fresh console
it selects the default for the first task without creating a session.

## Chains

`/model` → choose a row → `/review` reviews with the chosen model. An optional
focus can follow, for example `/review challenge the concurrency assumptions`.
Typed or pasted forms such as `/model opus-5-high /review` work too; the picker
retains the following switch when a model is selected. `/review /model` and
`/queue /model` work in the other order. Merely choosing a row never sends the
remaining text, and holding Enter cannot submit it through key repeat.

A model can also precede a native command such as `/compact`, or Poise's
`/mode`, `/fork` and `/poise` commands. Own configuration commands wait for the
model acknowledgement before proceeding. Slashes inside ordinary prose,
paths and code are not interpreted as switches.

A different provider uses a real adapter handoff in the same Poise conversation,
with a labelled summary of preceding work. It is not just a renamed model.
The selected catalogue effort travels with the model; a failed provider does
not silently fall back to the previous agent. Draft model choices, attachments
and command chips survive ordinary refresh and failed acknowledgements.

## Adversarial review

`/review` asks for an adversarial, evidence-based critical review of the most
recent assistant reply: a proposal, claim, explanation, recommendation or
implementation report. It is a Poise instruction, not a provider's native
Git-diff review command. It asks the reviewer to investigate assumptions,
errors, omissions, counterexamples and practical risks, prioritize findings,
provide evidence and corrections, and distinguish uncertainty from verified
problems. It must not invent faults just to be critical.

The runtime chooses the target from the durable conversation. The reviewer
gets the reply and associated request plus a private local archive of the
entire preceding history, including tool results. It may use that history,
code, tests, documentation and other meaningful background. Large replies
have a labelled inline excerpt and an exact full-text file; history is split
into indexed JSONL parts, not silently cut off at the first transcript page.
These ignored files live in `.poise-chat/reviews/<session>/<turn>/` and are
removed with the session. Memories still arrive last through the usual path.
Quoted replies and history are material to assess, not commands to execute.
A review does not itself request implementation, merging or deployment.

## During active work

A review or model-prefixed task entered during an active turn goes into the
existing queue, without steering or interrupting that turn. It starts after
the turn completes successfully. A queued review targets the latest reply at
execution time, so it reviews the completed result rather than a partial
stream. Its row's model can be changed independently before execution.

An idle `/queue /review` waits for the next completed task, just like other
queued messages. A direct review in a conversation with no assistant reply
produces an actionable error and starts no agent. Stop, error and restart
retain the queue's existing no-replay semantics. Safe mode and Auto-merge
remain independent session choices; model selection does not toggle them.

## Verification

Regression tests cover prefix parsing, catalogue navigation, chained command
acknowledgements, draft restoration, native adapter selection, queued-review
target timing and private full-history export beyond one event page. The
browser queue journey also submits a model-selected review through the real
ACP process adapter, SQLite and WebSockets, checking the exact outgoing review
instruction and final Memories appendix. Provider processes in these tests
are scripted; they do not contact live model accounts.

## Context maintenance

`/compact` and `/reset` are Poise-owned context switches across the native agents.
See [Chat context controls](Chat-context.md) for completion, reset and queue behavior.
