# JEV primitive workspaces

Choose **JEV · Primitive builder** in New session, or in the fresh console’s
model menu when JEV is configured. JEV uses the Chat workspace and sidebar,
but it is not a conversational agent. It does not start a CLI, checkout,
permission flow, reasoning stream or tool session.

## Build, then evaluate

Put the material to evaluate in **State**: plain text, a JSON object/array,
or an imported text file. Add a focused question, choose the answer shape,
and press **Evaluate**. Enter inserts a line; Command/Control + Enter evaluates.
Nothing is sent merely by opening the builder or choosing the example.

- **Yes / no · Noul** returns a probability of yes, not a forced boolean.
  Optionally describe what true and false mean.
- **Choose one · Choice** returns a named option and the complete probability
  distribution. Supply 2–255 options, with optional descriptions. Bulk paste
  accepts one option per line, optionally `name | description`.
- **Rate a scale · Score** uses 2–10 ordered descriptive levels. Results may
  fall between levels; the scale is indexed from zero.

Mix primitive types in one request. Each question evaluates the same state
independently. Duplicate questions to reuse a rubric; collapse completed
questions to keep the builder manageable. A local customer-triage example
illustrates all three types. It requires an explicit Evaluate click.

On a wide pane, State and Questions sit side by side. On a narrow pane they
stack. Evaluate stays accessible in the footer while the builder scrolls.

## Typed results and deeper control

Results show the selected option, probability of yes, or fractional score,
plus distributions, legends, model version, duration and token usage.
Choice/Score confidence is distribution certainty, not the selected option’s
probability. The exact request and response remain inspectable as JSON.
Malformed or incomplete upstream responses are errors, not accepted results.

**Request JSON** exposes structured instructions and criteria, not just text
fields. Valid requests round-trip back to Build without flattening objects or
arrays. Invalid JSON remains editable. Model details default to `jev-latest`;
use `jev-preview` or a versioned model ID for a different release.

History is an evaluation ledger, not model context. Each Evaluate sends only
that request. **Edit this run** opens its original input as a new builder.
**Use answers as state** explicitly starts a new builder using that result’s
answers. No other prior input, result, native Chat history or repository
content is included automatically.

Shared Memories still apply: their latest saved text is appended last to each
question’s instructions, leaving State unchanged. Structured instructions get
a final Memories element. **Preview exact request** shows this effective input.
Templates and Edit this run use the original request so Memories are not doubled.

**Load snippet** lists snippets containing valid JEV request JSON and can save
the current request as a snippet. Manage templates in Snippets, alongside other
skills. Saving includes State and Questions, not results or Memories. Ordinary
text skills are not silently interpreted as primitive schemas.

## Persistence, credentials and recovery

Set `JEV_API_KEY` in the server’s `.env` and restart Poise. The development
server loads it server-side too. It is not a Vite client variable and is not
included in browser API responses, stored workspace data or native CLI
subprocess environments. The server sends it only in the Authorization header
to the fixed HTTPS TypeSafe API. Redirects are refused. Building and saving
workspaces work without a key; evaluation requires it.

Builder drafts autosave locally and to Poise’s database. Concurrent tabs use
revision checks, preserving a conflicting draft until a deliberate reload or
replacement. Edits made during an evaluation affect the next request, not the
running snapshot. Workspaces and evaluation history survive reloads.

A run ID is recorded before the provider request starts. Repeating that ID
cannot create another evaluation. Lost acknowledgements can be checked or
resubmitted with the same ID; they are never automatically sent as a new run.
Stop aborts the local request. A timeout, interruption or cancellation may
still have been processed or billed upstream; it is not retried automatically.
A failed result write retains the result in memory with a copy-now warning
and retries saving, never the provider call. Server restart marks abandoned
running receipts interrupted rather than replaying them.

Poise bounds requests to 1 MiB/1,024 questions, drafts to 2 MiB, responses to
4 MiB and provider requests to 60 seconds. Provider context and account limits
also apply. Oversized or invalid inputs are rejected without truncation.
The release drain waits for active evaluations and still permits Stop.

Contract references: [Primitives](https://docs.typesafe.ai/primitives),
[API](https://docs.typesafe.ai/api), [Models](https://docs.typesafe.ai/models).

## Acceptance and integration notes

Each primitive shows the shape it returns while you build it. Result cards
repeat the original question beside its answer ID, so a set of judgments is
readable without opening JSON. Model details load the account's advertised
aliases on demand; versioned model IDs remain directly editable.

Requests are deep snapshots. Changes to score levels or structured criteria
while a save is pending cannot change the evaluation already submitted.
Out-of-order history polls cannot restore an old running state after Stop.
Text import is keyboard-accessible and checks UTF-8; a late file read never
replaces newer state or reports an error in another workspace.

An acceptance check on 2026-09-24 used one synthetic ticket and one request
containing all three primitive types. The real API returned `jev-1.13.0`,
valid typed answers, and usage of 387 input / 69 output tokens in 1.021 seconds
for that evaluation. This is one observation, not a latency guarantee.
The automated browser, storage and failure-injection tests use scripted
provider responses; they never read the developer's key for evaluations.

Poise reads `.env` from its configured runtime environment root. Development
and a separately installed production checkout can have different `.env`
files; set `JEV_API_KEY` in the environment used by the running server.

## Final interaction checks

New builders focus State so you can paste immediately. **Load text file**
opens the system file picker with either a click or keyboard activation, and
selecting the same file again is supported. Choice descriptions, Score levels,
and Noul rubrics use multiline editors; leading and embedded newlines survive
switching between Build and Request JSON.

Evaluate reveals the requested result above the builder, even when you were
editing its bottom row. It does not pull you away from a newer draft or another
workspace while the submission was pending. A result arriving through history
polling before its submission acknowledgement remains one completed result,
not a duplicate, a false receipt error or a return to the running state.

These interaction regressions use the actual browser/API/SQLite journey with
a scripted JEV provider. The file-picker, multiline-rubric, result-visibility
and late-acknowledgement tests each reproduced their failure before the fix.
