# Create reusable Chat switches

`/create` saves a text skill under a name you choose. There are no bundled
custom skills and no special behavior for any example name.

```text
/create /my-skill
Put the reusable instructions here.
They can span multiple lines, including Markdown and examples.
```

You can type this directly, or select `/create` from the slash palette and
then enter `/my-skill` followed by its content. Send saves the definition;
it does not send a message to an agent, start a session, stop a running task,
or require a model to be available. The console confirms the saved name.

Later, in any Chat conversation:

```text
/my-skill Do this task using the saved instructions.
```

Poise appends the saved content to that message before the final Memories
appendix. The visible transcript and recalled message keep the short switch
invocation rather than repeating the whole definition. A switch can also be
sent alone when its instructions contain the task. Saved names appear in
the slash palette and can be selected with the keyboard or mouse.

Definitions are shared across Chat sessions on this Poise instance. They
persist in Poise's database across reloads, restarts, updates and `/reset`.

## Chaining and updates

Saved switches compose with `/model`, `/review`, `/queue`, `/compact` and
`/reset`, and with other saved switches. For example, choose a model with
`/model`, then add `/my-skill /review` to apply that skill to a critical review.
`/queue /my-skill Later task` uses the latest saved definition when the queued
task actually starts. During active work, a plain saved-switch message steers
like an ordinary message; a model-selected or reviewed task joins the queue.

Run `/create /my-skill` with new content to replace that definition. Saves
are revision-checked so a stale tab cannot silently overwrite a newer edit.
Other open tabs receive the updated catalogue. Failed saves retain the
submitted definition alongside any newer draft. A message submitted while
a definition is saving waits for that save instead of racing ahead of it.
Application updates wait for these operations to settle. A manual refresh
restores pending definitions and dependent messages as unsent drafts; it never
automatically repeats an uncertain save.

Use `/create` on its own: everything after the name belongs to the definition,
not to a chain of actions to execute now. Stored text is never parsed for
Poise switches, so a literal `/reset` inside a skill does not reset the chat.
Using the same switch twice in a chain includes its definition once.

Names start with a letter and can contain letters, digits, hyphens and
underscores, up to 64 characters; matching is case-insensitive. Built-in and
known native command names cannot be replaced. A definition holds up to
64 KiB of UTF-8 text; the library holds up to 128 definitions or 512 KiB.
An expanded message must fit the existing 256 KiB prompt limit. Oversized
content is rejected with a readable error, never silently truncated.
