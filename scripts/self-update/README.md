# Poise release controller (`scripts/self-update/`)

The independent supervisor behind ordinary Poise change requests (`/poise` is optional): it turns an agent's
committed change into a pushed branch, a pull request, a CI-gated and verified
merge, an immutable release directory, a drained and health-checked switch of
the active release, and — on one click — a rollback to the previous release
that needs no model, network or build. It also replaces the legacy
`update-caller.mjs` fast-forward for Poise itself: a new `main` becomes a new
release through the same stage → drain → switch → verify path.

Enable it once using `npm run self-update:enable -- --token-file <path>`
(see `docs/Self-improvement.md`). The installer journals the bootstrap and
preserves the running service and Caller pin. It requires a config file with
`enabled: true` and a separate, `chmod 600` token file holding a fine-grained
GitHub token scoped to `mikkokotila/Poise` only. It never reads `gh`
credentials, `GH_TOKEN` or `GITHUB_TOKEN`.

## Layout of the root (`$POISE_SELF_UPDATE_ROOT`, default `~/.poise/self-update`, mode 0700)

| Path | Purpose |
| --- | --- |
| `config.json` | Controller config (see below). Written by an operator or `cli.mjs init`. |
| `release-token` | Default token file location (`tokenFile` in config or `POISE_RELEASE_TOKEN_FILE`). Must be 0600. |
| `bridge.key` | Shared secret for `/api/self-update/{readiness,drain,resume}` (`x-poise-release-key`). 0600. |
| `state.json` | Durable controller state: changes, releases, hold, switch intent, rollback ops. Atomic + fsync. |
| `journal.ndjson` | Append-only receipts for every commit. |
| `active-release.json` | The pointer the stable launcher reads: `{ id, sha, root, previousId }`. |
| `controller.lock` | One controller per root (PID-checked, stale locks reclaimed). |
| `heartbeat.json` | Daemon liveness, rewritten every 5 s. |
| `control.sock` | Private Unix HTTP socket (0600). |
| `releases/<id>/` | Immutable release: full clone at the exact SHA, `node_modules`, `dist/`, `release.json`. Never built in place; staged as `.<id>.staging` and renamed. |
| `workspaces/<changeId>/` | Isolated clone the agent works in (branch `poise/change-<uuid>` off the active SHA). |
| `logs/` | Captured stdout/stderr of every `npm ci` / `npm run check` / build, per change or release. |
| `controller/` | Trusted copy of these modules (`cli.mjs install-controller`); launchd should run `controller/daemon.mjs` and `controller/launch.mjs`, never a checkout. |

## `config.json`

```json
{
  "version": 1,
  "enabled": false,
  "repository": "mikkokotila/Poise",
  "branch": "main",
  "tokenFile": "/Users/you/.poise/self-update/release-token",
  "bridgeKeyFile": "/Users/you/.poise/self-update/bridge.key",
  "productionPort": 5555,
  "recoveryPort": 5556,
  "productionServiceLabel": "com.vaquum.poise",
  "callerSha": null,
  "nodeBin": "/opt/homebrew/opt/node@22/bin"
}
```

`repository` and `branch` are pinned; any other value makes the config invalid
and the controller reports itself disabled with the reason. `enabled` and the
token file are re-read on every decision, so `cli.mjs enable|disable` take
effect without restarting the daemon; path changes need a daemon restart.

## Control API (Unix socket, JSON; shapes from `src/self-update-types.ts`)

| Route | Result |
| --- | --- |
| `GET /status` | `SelfUpdateStatus` — all changes, active/previous release, hold, `recoveryUrl`. |
| `POST /changes` `{id, sessionId, instance, request, title?}` | `201 PreparedSelfChange`. Idempotent on id+payload; 409 on a different payload, a busy lane or a hold; 503 when disabled or the baseline is unhealthy. Writes the intent, then clones. |
| `POST /changes/<id>/session` `{sessionId, instance}` | `Change`. Binds the generated runtime session once; 409 for another instance. |
| `POST /changes/<id>/finish` `{outcome, error?}` | `202 Change`. `completed` queues the check; repeats are no-ops; cannot re-run a merge. |
| `POST /changes/<id>/rollback` `{expectedReleaseId}` | `202 Change`. Durable acknowledgement; stale release → 409. |
| `POST /rollback` `{expectedReleaseId}` | `202 {rollback, status}` — release-level rollback (CLI / recovery UI). |
| `POST /hold/clear` | Operator action; refused while a switch or rollback is pending. |
| `POST /tick` | Kicks reconciliation, returns `Status` immediately. |
| `GET /health` | Daemon liveness. |

Errors are `{error, code}` with the HTTP status. `scripts/self-update/client.mjs`
wraps this; `statusOrDisabled()` turns an absent daemon into a disabled `Status`.

## Change lifecycle

`implementing → checking → awaiting_ci → merging → merged → deploying → verifying → live`,
with `failed` / `blocked` (policy, needs a human) / `superseded` (a newer change
went live) / `reverting → reverted` (rollback; `sourceRevert` then tracks the
`git revert -m 1` PR: pending → checking → awaiting_ci → merged | conflict | failed).

Checking: tracked files clean, on the change branch, base is an ancestor,
head differs from base. Ordinary frontend, backend, scripts, documentation
and dependencies are eligible; there is no directory whitelist or file-count
limit. The trusted policy protects release/authorization machinery,
credentials, destructive migration statements and external publication
configuration. Package edits are checked by field: changing ordinary
dependencies is allowed; changing the validation/release commands is not.
Then `npm ci` and `npm run check` run in a scrubbed environment; the head and
working tree are re-verified, the exact head is pushed (never forced), and a
PR is opened with the request and session.

Merging: the controller verifies the repository identity, current PR head and
base, and successful `.github/workflows/ci.yml` checks for Node 20/22/24 on
that exact head. It does not require administrators to configure branch
protection; any GitHub restrictions already in force remain effective and
are never bypassed. The expected merge parents are journaled before the
remote write. `PUT …/merge` pins the head and uses a merge commit; the returned
commit must have exactly `[main, head]` as parents and the tested head's tree.
Uncertain outcomes are re-observed, not blindly repeated. A mismatch blocks
promotion, and a human merge is not misrepresented as a controller merge.

Deploying: stage release (`git clone` at the merge SHA, `npm ci`,
`POISE_RELEASE_SHA=<sha> npm run build`, manifest), drain the app with the
bridge key until `ready`, write the switch intent, write the pointer, restart
via `launchctl kickstart -k`, then poll `/api/health` (`build.sha`,
`build.releaseId`, scheduler ok; external sign-in degradation tolerated) and
`/api/chat/sessions`. Failure within the grace window restores the previous
pointer, sets a hold, restarts and verifies the restored release.

## Recovery UI (`http://127.0.0.1:5556/`)

Served by the daemon, not the app. Strict `Host`, same-origin `Origin` and
Fetch-Metadata checks on POST, single-use nonce per rendered form, no scripts,
`default-src 'none'` CSP, everything escaped. Offers "Roll back to previous
release" and, under a hold, "Clear promotion hold". `GET /status.json` mirrors
`/status`.

## CLI

```
node scripts/self-update/cli.mjs status [--json]
node scripts/self-update/cli.mjs tick
node scripts/self-update/cli.mjs rollback --expected <releaseId> [--change <changeId>]
node scripts/self-update/cli.mjs clear-hold
node scripts/self-update/cli.mjs report
node scripts/self-update/cli.mjs init --token-file <path> [--caller-sha <sha>] [--node-bin <dir>]
node scripts/self-update/cli.mjs install-controller
node scripts/self-update/cli.mjs bootstrap-release --sha <sha>      # real npm ci/build; operator only
node scripts/self-update/cli.mjs enable | disable
node scripts/self-update/cli.mjs daemon
```

## Stable launcher

`launch.mjs` reads `active-release.json`, checks the release manifest matches,
sets `POISE_RELEASE_ID` / `POISE_RELEASE_SHA` / `POISE_RELEASE_ROOT`, `chdir`s
into the release and starts `dist/server.js` in-process. A missing or
mismatched pointer exits 78 so launchd retries while the recovery UI stays up.

## Worker lifecycle

Daemon, CLI and installer all use `safe-runner.mjs` (the `runner.mjs` import
is a compatibility re-export). A worker gate waits for durable registration
before GO, and the registry is cleared only after its process group settles.
Unverified surviving groups remain recorded and block automatic work. The
daemon keeps its exclusive lock until the in-flight reconcile settles on
shutdown. Recovery-page and Chat-card rollbacks both lift their promotion hold
after the corresponding source revert has been verified and merged.
