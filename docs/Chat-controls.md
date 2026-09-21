# Chat permissions and display controls

Safe mode is off by default for new chats and records without a saved choice.
Native tools run with full access, without an operating-system sandbox or
routine Poise approval prompts. This is a trusted local-agent workflow, not
an isolation boundary. It does not grant new merge authority: Auto-merge is
still a separate choice, and the Poise release controller is unchanged.

Enable **Safe mode** to use the agent's native risk-based approval handling,
still without a sandbox. Claude and Grok use their `auto` approval mode;
Codex uses `on-request` with full access; Muse uses `onRequest` with its shell
sandbox disabled. Native policy denials and account restrictions still apply.
Actual questions that need information are not answered with invented data.

The choice is saved per session, inherited by forks and handoffs, and used
when queued tasks start. A fresh-console choice survives a tab reload.
Changing permissions never needs a successful Memories save. Claude and Muse
can apply the setting during a turn; Codex and Grok may defer it. The icon
and nearby status explicitly show a pending next-turn change, and the next
native start/resume receives the saved setting. Stop remains independent.

**Reasoning** is a separate, default-off display toggle. It reveals or hides
provider-supplied reasoning without changing tools, model effort or prompts.
**Activity** controls tool/plan details; messages, errors and outstanding
questions or approvals remain visible. Neither display toggle deletes history.

Icon-only buttons show short labels after one second of hovering. Keyboard
focus works too; leaving, clicking, scrolling or Escape dismisses the tooltip.
