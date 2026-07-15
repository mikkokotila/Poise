# Poise

Poise is a local engineering dashboard for GitHub work, agent activity,
automations, snippets, and long-form writing. It is a TypeScript application
with a framework-free browser client, a Node server, and a small SQLite store.

## Capabilities

- **Current** — manual idea/concept/plan cards beside live issues and PRs.
- **Swarm** — agent run status, responses, and safe replay controls.
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

## Production

```bash
npm ci
npm run build
npm start
```

The production build emits the browser client under `dist/client` and the Node
entrypoint at `dist/server.js`. The server binds `127.0.0.1:5555` by default.
Poise intentionally refuses non-loopback bindings: its API can create GitHub
issues, launch agents, and modify local files, so it is not a network service.
Keep `.env` owner-readable only (`chmod 600 .env`) because it may contain the
Confab API credential; `npm run doctor` rejects broader permissions.

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

## License

MIT — see [LICENSE](LICENSE).
