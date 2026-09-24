# Review New Issues

An adversarial review of each new issue in the repositories you opt in, and of
every sub-issue it makes part of itself. One to three reviewers work on each
issue at the same time. Each is its provider's own coding-agent CLI with full
access to a fresh checkout of the repository: it reads the whole codebase and
its history, builds, and runs the tests. Every comment is posted as the review
agent (`REVIEW_AGENT_USERNAME`, bit-mis).

The instruction each reviewer gets is fixed:

> Provide an adversarial, meticulous, and comprehensive review with comments
> on `owner/repo#N` and any issue directly linked to it.

The behavior's memory (the Memory column) is added to it, as for the PR
behaviors.

## Turning it on

Behaviors → **Review New Issues**:

- **Setting** opens the trigger dropdown. Tick the repositories whose new
  issues are reviewed; nothing is reviewed until at least one is ticked, even
  with Active on. The list is the configured organization's repositories, the
  same list Current uses. Below it, **Trusted authors** lists the GitHub
  accounts whose issues count: `mikkokotila, zero-bang, bit-mis` by default.
  Every way of closing the dropdown saves it.
- **Reviewers** chooses how many of the Issue review models review each issue.
- **Active** is the switch.

Settings → Models → **Issue review** names the models: a default, the
fallback Caller switches to once after a Claude output limit, and the
secondary and tertiary reviewers. It offers every provider Caller can run with
full access — all five: Claude, Codex, Grok, Antigravity and Muse.

## Which issues

An open issue is reviewed once, when all of these hold:

- its repository is ticked, and the issue was opened after it was ticked —
  ticking a repository never reviews its backlog;
- its author is one of the trusted authors;
- it has been open for 10 minutes, so sub-issues and links added right after
  opening it are part of the review.

An extra reviewer reviews only the issues opened after the panel grew to
include it. Edits, new comments and the review agent's own comments never
start another review; Replay in Swarm runs one by hand. At most three
reviewers run at once across all issues; the rest wait for a free slot.

## Sub-issues

"Directly linked" means the issue makes the other issue its sub-issue, one
level deep, in either of the two ways GitHub work here does it:

- a GitHub sub-issue of it;
- an issue linked under its own **Work Slices** heading — how an Origo PRD
  makes its Slices part of it.

A mention elsewhere in the text, a `Depends on`/`Unlocks` line or a Slice's
`Parent issue:` line does not make one, nor does anything inside a code block
or an HTML comment. The heading may read `Work Slices`, `Work Slices:` or
`5. Work Slices`. A linked sub-issue must belong to the same owner as the
issue, as GitHub's own sub-issues do; it can live in another of that owner's
repositories, and reviewers comment on it there.

## What a reviewer does

Caller (`agent-interface --issue-review`) reads the issue, its comments and
each sub-issue with its comments through github-interface, clones a fresh
checkout of the repository's default branch with full history from a local
mirror, and starts the provider's CLI in it with no tool restrictions and no
sandbox. The mirror (`~/.cache/github-interface/mirrors`) and the checkout
(`~/.cache/agent-interface/issue-review`) are outside `~/dev`; the checkout
is deleted when the reviewer finishes. The reviewer does not post. It writes its
comments to a file; Caller posts them through github-interface as the review
agent — one comment per issue per reviewer (in parts when it is longer than
GitHub takes in one), only on the issue and its readable sub-issues, each
signed with the reviewer's model:

```
---
Issue review · `opus-5.5-max`
```

Reviewers work independently, so the same finding can appear twice, as with
the PR review panel. When a reviewer finishes, anything still running in its
checkout — a dev server, a watcher, a process that detached — is stopped
before the checkout is deleted.

Comments are posted as the account github-interface comments with (bit-mis);
Caller refuses a run whose actor is any other account before it reads or posts
anything. A Claude reviewer runs through Poise's Claude subscription wrapper,
like every other Claude launch, keeping Claude Code's own system prompt.

## In Swarm

Each reviewer is its own row, `issue_review`, with the same detail as a PR
review: live stage and heartbeat, provider reasoning, time elapsed, Stop, the
response (the comments it posted) and Replay. Its target links to the issue,
and a finished review reads *completed · posted*.
Stages specific to issue review are *Reading the issue*, *Preparing a fresh
checkout* and *Posting review comments*.

## When a reviewer fails

- Failed before posting anything: Poise launches that reviewer once more, then
  holds it.
- Began posting, then failed: held, never relaunched — it may already have
  commented. Caller records every comment the moment it is posted, and records
  that posting began before the first. An issue that refuses a comment (locked,
  deleted) does not stop the others from getting theirs.
- Stopped, out of time (one hour of wall-clock time, sleep included, with
  the one recovery), recovery failed, or an issue too large to review: held.
- A worker whose launch was never recorded — the process died in between — is
  taken over by a later scan after five minutes. One that has not yet
  registered its run is not relaunched while it is still alive.

A held reviewer is listed in the Behaviors diagnostics until the issue closes
or its repository is unticked; Replay in Swarm runs it again on purpose.

## Trust

The reviewers run as you, on this machine, with full access — the same as a
Chat session in unrestricted mode, except that what they read was written by
whoever opened the issue and its sub-issues. The trusted-author list is the
guard: keep it to accounts you trust. A disposable checkout keeps them away
from your working copies; it is not a sandbox. See SECURITY.md.

## Caller contract

- `agent-interface --issue-review OWNER/REPO#N --model M [--recovery-model R]
  --actor USER --source SOURCE --correlation-id ID [--note TEXT]`
- `agent-interface --models` lists `issue_review_providers`; without it Poise
  reports *Update Caller: issue review is unavailable* and launches nothing.
- Log rows: `behavior: issue_review`, the issue number in `pr_id`, no
  `expected_head` or `head_sha`, `action`/`outcome` `commented` when done, and
  `receipts` — `null` until posting begins, then the comments posted
  (`issue`, `comment_id`, `url`, `author`).
- github-interface primitives: `--read-issue`, `--issue-comments`,
  `--sub-issues` and `--comment-issue`, each with `--repository OWNER/REPO`,
  and `--checkout-repo OWNER/REPO --path DIR`.

Poise must be deployed before a Caller that writes `issue_review` rows: an
older Poise cannot read them and would stop reading the whole agent log.
