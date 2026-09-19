# Poise

Poise is a local engineering dashboard for GitHub work, agent activity,
automations, snippets, and long-form writing. It is a TypeScript application
with a framework-free browser client, a Node server, and a small SQLite store.

## Capabilities

- **Current** — manual idea/concept/plan cards beside live issues and PRs.
- **Swarm** — agent run status, live review activity, responses, and safe replay controls.
- **Chat** — native coding-agent sessions with streaming, tools, permissions and checkout-bound work.
- **Archive** — searchable GitHub issue and PR history.
- **Behaviors** — scheduled review, approval, and unblocking automations.
- **Snippets** — simple Espanso trigger management.
- **Editor** — atomic Markdown storage, annotations, and agent-backed chat.

## Requirements

- macOS, Linux, or WSL. Native Windows is not supported.
- Node.js 20.19, 22.13, or 24.x and npm. Use an active LTS line in production.
- `gh`, authenticated with `gh auth login`.
- Claude Code, authenticated to a Claude Pro or Max subscription with
  `claude auth login --claudeai`. Poise does not require an Anthropic API key.
  On Linux/WSL, in-app sign-in requires an active graphical desktop session.
- `github-datastore`, `github-interface`, and `agent-interface` on `PATH`.
- The other provider CLIs the catalog offers — `codex`, `grok` (Grok Build),
  `agy` (Antigravity), `muse` — each signed in. The production services run
  with their own `PATH` (Caller's release, then `~/.local/bin`, then Homebrew
  and the system), not the shell's; `npm run doctor` looks each CLI up there.
- A local checkout of `agent-interface`; set `AGENT_INTERFACE_ROOT` when it is
  not at `~/dev/caller/agent_interface`.
- Espanso is optional and only required for system-wide snippet expansion.

Validate the local integrations without changing external state:

```bash
npm run doctor
```

GitHub credentials stay in `gh`. Poise resolves the selected account's token
through `gh` only for the lifetime of an issue-creation subprocess; it does not
persist or expose that token. On upgrade, the schema migration removes the
retired plaintext `github_token` row while preserving legacy content tables.

Claude credentials stay in Claude Code's local credential store. Poise checks
the subscription session in the background, pauses only Claude-backed work
when verification fails, and opens the Claude.ai sign-in flow from an in-app
prompt. Ambiguous provider failures also offer reconnection without labeling a
network outage as a rejected credential. A local wrapper uses an exact process
environment allowlist, an isolated Anthropic profile store, and one merged
settings overlay that neutralizes provider credentials and credential helpers.
Immediately before each model process, it requires Claude Code to report the
Claude.ai first-party provider. This keeps Poise-owned calls from silently
switching to Console/API credentials. One failed worker attempt also opens a
durable per-behavior circuit breaker, and Poise disables Claude Code's built-in
request retry loop, so neither layer can repeat provider calls during an outage.

Verification uses local status polling once per minute plus one minimal Haiku
request at startup, after sign-in or a failed worker, every six hours while
healthy, and immediately before a scheduled agent launch when the last canary
is at least one minute old. Concurrent launch gates share the fresh result.
These probes consume Pro/Max usage. Anthropic can bill account-level [Usage
Credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)
after included limits; disable them under Claude account Settings > Usage if you
need a hard spending cap. Poise can isolate provider credentials, but it cannot
change that account-level billing control. Transient probe failures back off for
up to one hour; expired tokens fail closed until sign-in succeeds. Failed
behavior scans and workers also back off exponentially for up to one hour,
survive restarts, and keep `/api/health` degraded until a clean scan or worker
success confirms recovery.

## Development

```bash
npm ci
cp .env.example .env
chmod 600 .env
npm run dev
```

Open <http://localhost:5555>. Configure the GitHub organization, username,
timezone, refresh interval, and theme in Settings.

Models have one name everywhere: the identity `<family>-<version>-<effort>`
from Caller's catalog (`opus-5-max`, `gpt-6-astra-ultra`, …), the same string
the Swarm log records. Settings → Models lists every place Poise launches a
model — Chat, Editor chat, PR review, PR approval — with a default and a
fallback each, plus the places Caller decides on its own (`/content`,
`/consensus`, fix failing CI, simplify issue, the sign-in check). Every place
offers every catalog model; review places follow the providers Caller lists as
reviewing (all five since Caller #39: Claude with governed tools, the others
with a structured verdict), and their fallback is the recovery model Caller
switches to once after a Claude output limit. For chat places the fallback
launches when the default's provider is not signed in. A choice the catalog no
longer contains resolves to the Caller default and says so in the pane.

The PR review place also names a secondary and a tertiary reviewer (seeded
from different families than the default). The Reviewers column of the
Behaviors view decides how many of the three review each new pull request —
primary only by default, primary + secondary, or all three — and they run at
the same time, each as its own Swarm row with its own model and Stop button.
Every review posts as the configured reviewer, so the pull request ends up with
the union of their findings; a bug two reviewers find in the same minutes can
appear twice, since github-interface deduplicates only against threads already
posted. Each run reports the review it submitted (Caller records the GitHub
review id as its receipt), so a reviewer that dies is relaunched exactly like a
single review is: once every review posted since its launch is accounted for by
a sibling. Approvals stay with the default model. A wider panel applies to
pull requests opened after the change; the manual Review button in Swarm keeps
launching the default alone.

The catalog holds the latest model of each family with its top two efforts
(three for Claude, so reviews can run at high; Claude keeps Opus and Fable,
Codex Astra and Sol).
Every morning at 07:00 `com.vaquum.poise.model-catalog` asks each CLI what it
offers (`agent-interface --refresh-models`) and rewrites the catalog when
something changed; Settings → Models → Check now does the same on demand and
shows the last report. Reviews need Caller 0.3.0 or newer (`agent-interface
--models`); an older Caller fails before launching a worker. The compatible
review policy is `bounded-v1`: reviews have a total 23m33s budget. Timeouts and
failed recovery remain visible and are held across restarts for the same
input/model; new commits, new approval input, or a model change can be retried.

## Production

```bash
brew install node@22 python@3.13
npm ci
npm run install:production
```

The macOS installer builds Poise, resolves the tracked Caller ref in
`config/caller-release.json` to an immutable release, installs the Claude and
Codex stop gates, and registers three per-user launchd services. They keep
Poise alive, check `/api/health`, and reconcile Poise `main`, Caller, and both
agent hooks from their remote sources every minute. Updates use fast-forward
only and refuse to overwrite a dirty production checkout; a fast-forward whose
install did not complete is installed again on the next run. Output is in
`~/.poise/logs/caller-update.out.log` and failures are in
`~/.poise/logs/caller-update.err.log`. Each run also records its outcome in
`~/.poise/production-update.json`: Settings → General shows the deployed
commit against `main` from it, and the health monitor sends a desktop
notification when the updater has been failing for five minutes or has not
run for ten, and again when it recovers. A transition to degraded health
produces a desktop notification; expired Claude authentication also opens
Poise's subscription sign-in prompt.

Keep the production checkout outside `~/dev` (for example
`~/.poise/production`): the updater needs it permanently on `main` and clean,
which a working checkout is not.

The production build emits the browser client under `dist/client` and the Node
entrypoint at `dist/server.js`. The server binds `127.0.0.1:5555` by default.
Poise intentionally refuses non-loopback bindings: its API can create GitHub
issues, launch agents, and modify local files, so it is not a network service.
Keep `.env` owner-readable only (`chmod 600 .env`) because it may contain the
Confab API credential; production startup rejects broader permissions and any
unmanaged or mismatched Caller release.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `POISE_HOST` | Production bind address; loopback only | `127.0.0.1` |
| `POISE_PORT` | Production port | `5555` |
| `POISE_DB` | SQLite path | `~/.poise/cache.db` |
| `POISE_EDITOR_DIR` | Markdown and annotation directory | `~/.poise/editor` |
| `POISE_CHAT_ATTACHMENTS_DIR` | Durable chat attachments | `~/.poise/chat-attachments` |
| `POISE_ESPANSO_MATCH_DIR` | Espanso match directory override | macOS Espanso default |
| `AGENT_INTERFACE_ROOT` | `agent-interface` working directory | `~/dev/caller/agent_interface` |
| `AGENT_INTERFACE_DATA_DIR` | Durable agent-interface calls and responses | package default |
| `POISE_VOICE_GUIDE_PATH` | Optional editor-chat voice guide | unset |
| `REVIEW_AGENT_USERNAME` | GitHub identity used by review automation | unset |
| `CONFAB_URL` | Optional Confab service | `http://localhost:8000` |
| `CONFAB_API_KEY` | Optional Confab bearer credential | unset |

The browser keeps view, filter, typography, refresh, and theme preferences in
`localStorage`. SQLite uses WAL mode and stores local settings, manual cards,
and automation deduplication state. Editor documents remain plain Markdown.

## Quality gates

```bash
npm run check      # typecheck, lint, unit/integration tests, production build
npm run test:e2e   # Playwright smoke and visual regression tests
npm run verify     # both suites
```

CI runs the static, unit, build, and audit gates on Node 20, 22, and 24. Node 22
also runs the browser suite and uploads its report.

## Architecture

- `src/` — browser views and interaction logic.
- `server/cache-plugin.ts` — shared API middleware for development/production.
- `server/production.ts` — loopback-only static and API server.
- `server/process.ts` — bounded external process execution.
- `server/db.ts` — SQLite schema, migrations, and automation claims.
- `tests/` — unit, integration, browser, and visual regression coverage.

See [SECURITY.md](SECURITY.md) for the supported trust boundary.

## Stopping a run

Every Swarm row that is still running has a Stop button. The first click arms
it ("Sure?"), the second click asks Caller to stop the run: `agent-interface
--stop` signals the call's process group and closes the row as failed with
`error_code: stopped`. A stopped review or approval is held for that head like
a bounded failure — it is not relaunched by the next tick; a new head or a
replay is a fresh decision. A stop is not counted against the Claude sign-in.
Needs a Caller release with `--stop`; older releases answer "Update Caller".

## Review activity in Swarm

With a current Caller release, review/approval rows show the last
observed stage. Expand a row for timestamped activity, worker heartbeat age, last
provider event age, and the current stage deadline. Active runs refresh every 15
seconds while Swarm is visible. Missing heartbeats, provider silence, incomplete
events, and runs without instrumentation are labeled explicitly. These labels
report observations; they do not change review outcomes or trigger retries.
Each minute records whether new reasoning activity arrived. Expand **Provider
reasoning** to read the latest 65,536 characters exposed by the provider, when
available. These details load on demand, outside the main log payload. Polling
updates existing rows and text in place, preserving expansion and scroll position.

## Native-agent Chat

The full Chat view owns persistent sessions for Claude Code, Codex, Grok Build
and Muse. New sessions use Git-ignored storage inside Poise, with no repository
or branch picker. It includes inline permissions and
questions, steering, Stop, durable transcripts, and Current/Swarm/Editor
handoffs. It requires the companion Caller turn-recording and checkout-lock
changes; the existing pane stays available for `/content`, `/consensus` and
Editor annotations in v1.

The fresh console accepts a message directly. Opus 5 High is the starting
default; click its label in the console to choose another catalogue model and
effort from the dropdown. First Send uses that choice without a creation dialog.
The draft and model choice survive session-creation errors. The sessions
pane is edge-resizable, remembers its width, and expands/collapses smoothly
while respecting reduced-motion preferences.

The New session model picker lists all five catalogue providers and each
model’s exact effort variants. Unavailable integrations, including the current
Antigravity CLI’s missing interactive permission channel, remain visible with
an explanation. Existing sessions are preserved.

The activity icon beside Fork switches between the detailed transcript and
messages with any pending questions, permissions or errors. Local file links
open read-only previews, and internal Muse reminder cards are not displayed.

See [Chat v1](docs/Chat-v1.md) for architecture, recovery, release integration
and the distinction between automated coverage and live-agent verification.

## Queue follow-ups

Use `/queue <message>` to add a task to the collapsible Queue section above
the console. Each row chooses its own agent, model and effort. During a turn,
items wait for its completion; while idle, they wait for the next task you
send normally, then run one by one. Queueing alone never starts a turn.
Saved items survive reloads, and Stop preserves the waiting tail.
See [Queued Chat messages](docs/Queue.md).

## Improve Poise from Poise

After the one-time release-controller installation, a Poise implementation
request in Chat can proceed through implementation, checks, CI, automatic PR
merge, a verified release and safe tab refresh. Natural requests are supported;
`/poise` is an optional shortcut. Other repositories do not inherit this merge
authority. The persistent deployment card provides one-click **Revert** for
the latest eligible change, backed by a retained release rather than another
agent turn. Caller and persistent application data keep their existing versions
and locations.

See [Self-improvement](docs/Self-improvement.md) for the setup commands, release
boundary, independent recovery, maintenance, and verification record. The
initial controller/bootstrap PR is reviewed manually; routine eligible Poise
changes do not require another merge confirmation.

## License

MIT — see [LICENSE](LICENSE).

## Auto-merge batches

The rightmost Chat header icon enables **Auto-merge** for the selected session.
The agent carries all requested slices and PRs across repositories through
checks, fixes and verified merges, deferring non-blocking questions until the
end. It is off by default, retained per session, and available before the
first message. Native tool approvals use once-only decisions recorded in the
transcript. See [Auto-merge mode](docs/Auto-merge.md).

## Chat memories

The rightmost **Memories** icon opens a free-text pane. Its autosaved text is
shared across Chat sessions and included last in every outgoing Chat prompt,
after attachments and other injected context. This includes queued tasks,
steering, handoffs and Poise implementation messages. Closing the pane leaves
memories active; clearing the text removes the appendix from future messages.
See [Memories](docs/Memories.md) for persistence and recovery details.
