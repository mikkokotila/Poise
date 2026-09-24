# Security policy

## Supported deployment

Poise is supported as a single-user local application bound to loopback. The
production server refuses non-loopback addresses. API requests enforce allowed
hosts, same-origin browser access, bounded bodies, and explicit content types.

Do not expose Poise through a public listener or reverse proxy. Its intended
capabilities include launching local agent processes, modifying local Markdown
and Espanso files, and creating GitHub issues through the authenticated `gh`
session.

## Reporting

Report vulnerabilities through the repository's GitHub Security Advisory
interface. Do not include credentials, private repository content, agent
responses, or local file contents in a public issue.

## Secrets

Keep `.env` local. Confab credentials are read server-side and are never
embedded in the browser bundle. GitHub authentication is owned by `gh`. For
issue creation, Poise resolves the selected account's token through `gh` and
passes it only to that short-lived `gh api` subprocess; Poise does not persist
or expose the token. Because upgrades are otherwise non-destructive, schema
initialization explicitly purges the retired plaintext `github_token` metadata
row while preserving legacy content tables.

Claude authentication is owned by Claude Code's local credential store. Poise
retains only sanitized in-memory health metadata; it never returns tokens,
account email, organization identifiers, or login output through its API.
Claude-backed subprocesses use a monitored local wrapper that discards
non-allowlisted environment variables, isolates the separate Anthropic profile
store, and consumes caller settings into one overlay where Poise-controlled
provider fields win. It neutralizes API helpers plus Anthropic, AWS, Bedrock,
Mantle, Vertex, Foundry, gateway, socket, and identity-token routes. Immediately
before every model process, the same effective environment must report an exact
Claude.ai/first-party status or the launch fails closed. A durable exponential
per-behavior circuit breaker suppresses repeated model calls and external scans
after failures, and the wrapper disables Claude Code's own provider request
retries. Sanitized breaker state is exposed through `/api/health`; provider
output is not. The supported path remains the user's Claude.ai Pro or Max
subscription on macOS, Linux, or WSL; native Windows is rejected rather than
falling back to a shell-based wrapper.

This isolation prevents provider-credential fallback, but it cannot disable
Anthropic account-level Usage Credits. Users requiring a hard spending cap must
disable Usage Credits under Claude account Settings > Usage.

## Chat sessions

The Chat WebSocket applies the same loopback host and browser-origin boundary
as the HTTP API. Requests and output buffering are bounded. Mutating commands
use durable receipts, so reconnecting or retrying an uncertain request cannot
silently start the same work twice. Transcript events, attachment records and
Caller delivery state remain local data.

Checkout locks coordinate Poise instances and compatible Caller writers; they
are not a system-wide filesystem lock. Registered worker groups and in-flight
Poise file operations must settle before releasing a checkout. Uncertainty
keeps it blocked rather than allowing another writer to proceed. Native
agents now launch without an OS sandbox in both Chat permission modes. Safe
mode is off by default (full access); enabling it retains native risk-based
approvals. A working directory is not a filesystem boundary. Poise's own filesystem
services use checked checkout paths, bounded reads and atomic writes.

Uploaded files have server-issued, session-owned records. Editor handoffs use
separate staged copies and version-checked writeback; conflicts are preserved.
Revert requires a trustworthy pre-image and an unchanged post-image. A failed
read must never be interpreted as proof that a file did not exist.

Provider credentials are not transferred into the browser or another agent.
Claude's existing subscription isolation applies to SDK sessions as well as
one-shot work. The other installed CLIs retain their own login state.

New-session creation does not accept a repository, branch or filesystem path
from the browser. Workspace files live under the ignored `.poise-chat/`
directory inside Poise. Its private Git repository has no remote and never
uses the enclosing source checkout for checkpoints. Symlinked storage roots
and unowned non-empty workspace directories are refused. Existing sessions
retain their original boundaries; no histories or documents are relocated.

### Chat file previews

Clicking a local Markdown link requests a bounded, read-only text preview.
The existing loopback/origin checks and runtime session ownership apply.
Paths must resolve inside that session's checkout or a tracked Poise source
checkout. The latter is the running installation or the configured checkout
for the repository in Poise's own package metadata, with its origin verified;
a link cannot name a different repository to authorize. Hidden/private paths,
credential-like files, symlink escapes and non-regular files are not served.
Reads use a no-follow file descriptor, a 512 KiB byte ceiling and a 5,000-line
presentation limit. Contents render as text, never active HTML. Previews do
not launch an agent or switch checkouts; they describe the current file only.

## Review New Issues

Issue reviewers are unattended coding agents with full access: each runs its
provider's own CLI without tool restrictions or a sandbox, as the local user,
in a fresh checkout of the issue's repository. Unlike a Chat session, the text
steering them was written by whoever opened the issue, its sub-issues and
their comments. The behavior is off until a repository is ticked, and only
issues opened by the trusted authors listed beside it are reviewed; keep that
list to accounts you trust. Sub-issues and comments by others remain part of
what a reviewer reads.

The checkout is a disposable clone outside `~/dev`, made from a local mirror
with the token passed per git command and stored in neither repository; it
is not a filesystem boundary. From a reviewer's shell every same-user
credential is reachable — `gh`'s accounts, SSH keys, provider logins.
Reviewers are told not to post; Caller posts their comments through
github-interface as the review agent and only on the issue and its
sub-issues, but "comments only" is an instruction to the agent, not a limit
it cannot break. Processes a reviewer leaves running are killed with its
process group when it exits.

## Poise self-improvement releases

Self-improvement authority is limited to a user-authored Poise change request.
The independently installed controller fixes the repository to
`mikkokotila/Poise`; model output cannot select a different repository or grant
merge authority. A protected change to release/rollback, validation or
authorization machinery, credentials, destructive migrations, or another
package's release configuration requires separate review.

The controller holds the release credential; it is not forwarded to native
agents, candidate builds, or the browser. Exact revision checks and CI precede
automatic merge. Retained complete releases, an atomic active pointer and a
separate recovery service make software restoration independent of models,
GitHub and rebuilds. A rollback hold prevents automatic re-promotion of the
rejected release. Current/previous identities refer to the served artifact,
not merely a checkout revision.

These are local, same-user processes. Environment isolation and scoped tool
permissions are not an operating-system sandbox: native tools, dependencies
and candidate code must still be treated as code running as the local user.
The workflow does not promise to undo arbitrary data loss, external side
effects, or stolen credentials by reverting source code. Persistent data and
Caller remain outside the replaceable Poise artifact and retain their existing
locations and permissions. Deployment handover waits for admitted work;
shutdown of a browser connection is not proof that its file operation ended.

## Explicit session Auto-merge delegation

The user can separately enable Auto-merge in a Chat session for requested work
across repositories. The server validates a boolean command, session ownership
and durable replay receipts; agent output cannot toggle the setting. Merge
delegation is independent of tool permissions. Safe mode controls whether
native risk approvals are shown; Auto-merge cannot override Safe mode. In
unrestricted mode, once-only native approvals are recorded as `unrestricted`,
not forged manual clicks. Questions still require real answers. The shared
instructions require normal repository checks/protections and verified merges;
those are not replaced by a new general-purpose server merge gate. The
Poise-only release controller and its credential scope remain unchanged.
See [Chat controls](docs/Chat-controls.md) for policy application timing.

## Deferred Chat messages

Queue commands keep the existing session ownership and request replay checks.
Enqueue and its transcript receipt commit together; claiming an item and
reserving its open turn are also atomic. Only a recorded, successful turn with
settled worker/file operations can advance the tail. Crash recovery never
re-executes a claimed uncertain task. Browser reloads do not dispatch tasks.
Queued attachments use validated server records and checked content hashes;
cross-agent handoffs retain the workspace boundary. An isolated Poise change
keeps its checkout exclusive to the release controller until that release
settles, then allows queued follow-ups. Queueing neither broadens credentials
nor changes the session's explicit Auto-merge delegation.

## Shared Chat memories

Memories are user-authored context stored in Poise's private SQLite metadata,
not a repository file or an agent-managed native memory store. The same-origin
GET/PUT endpoint uses transactional revision checks to prevent silent stale-tab
overwrites. Text is preserved verbatim with a 64 KiB UTF-8 limit. Browser drafts
are retained on save failures; message dispatch waits for outstanding edits.

Only the runtime supplies the memory appendix, after parsing the original
request and validating attachments. Memories do not toggle Auto-merge, select
repositories, or independently authorize a self-release. All four native
adapters place them after other human-message content. As prompt content they
are sent to the selected provider and may remain in its native conversation;
clearing memories affects future messages, not historical provider context.

## Reply-review context

`/review` resolves its target from the server's own session transcript before
starting a direct review, or at dispatch for a queued review. Browsers cannot
substitute a different session's reply or archive. A model-prefixed task is
reserved once through the existing command-receipt path; model selection does
not grant merge authority or change Safe mode.

The reviewing agent intentionally receives access to the full preceding
conversation, including tool outputs. Generated reply and paginated-history
files are private local staging under ignored `.poise-chat/reviews/`, created
with restrictive permissions and checked paths while the checkout lease is
held. The visible transcript records the person's original command, not a
second copy of the generated archive. Session deletion removes its review
staging. These are same-user filesystem files, not a separate OS sandbox;
review instructions identify quoted history as evidence rather than new
execution instructions. Credentials retain the existing provider isolation.
