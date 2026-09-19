# Improving Poise from Poise

A Poise implementation request is a delegation for that change: implement it,
validate it, open and merge its PR, and make it available in the current tab.
There is no second merge-approval step for ordinary Poise improvements.
Discussion is still discussion. Other repositories retain explicit human merge
approval unless the user enables the separate session-level [Auto-merge mode](Auto-merge.md).
That opt-in does not expand the controller's fixed repository identity.

For example, type **Add a search box above the session list so I can filter
sessions by their titles.** The deployment card follows the request through
implementation, local checks, CI, merge, activation, verification, and Live.
The `/poise` and `Poise:` prefixes are optional shortcuts, not prerequisites.
The currently selected native model implements the request.

## Release authority

Only the controller publishes and merges automatically. The implementation
agent works in a separate checkout and commits its work there. The controller
validates the exact head, current base, required GitHub Actions checks, and
merge result. A successful agent message is not evidence of successful checks,
a merge, or a deployment. The same controller policy applies to every model.

Routine frontend and backend changes are eligible. The exceptions are changes
to the release/rollback controller or its authorization/validation machinery,
credentials, destructive data migrations, and external-package release
configuration. Those exceptions require explicit review rather than allowing
the implementation to alter the mechanism that enforces its own authority.
There is no UI-only whitelist and no per-change administrative setup.

A source or CI failure never authorizes a partial or unverified deployment.

## Activation and rollback

The independently installed controller lives outside the releases it replaces.
It stages a complete release, including its dependencies and built assets,
while the active installation continues serving. The Caller revision and
persistent data locations are carried forward unchanged.

Activation first closes admission to new application work. Existing turns and
in-flight filesystem/API/background work settle; idle native sessions are
closed without losing their resume identities. The stable launcher selects a
release through an atomic pointer. Health verification uses the SHA compiled
into the served bundle, not the Git checkout's HEAD or the updater's report.
A candidate that does not become healthy is rejected and the retained release
is restored. Failed candidates are held back from automatic re-promotion.

**Revert** is bound to a particular change and expected active release.
It restores the previous verified artifact without asking an agent, building
code, or contacting GitHub. Duplicate clicks refer to the same durable
operation. Stale cards cannot roll back unrelated later work. Source history
is reconciled afterward through a checked revert PR; conflicts leave the safe
release running with an explicit source-reconciliation status.

The recovery page and command-line control remain available independently of
the main Poise application. Software rollback is not a reversal of arbitrary
data deletion, external side effects, or credential changes. The automatic
lane does not authorize those effects merely because the change touches Poise.

## Safe tab adoption

The tab compares its compiled build identity with the build actually served.
When idle and safe, it persists Chat drafts and the selected session, reloads
once, and restores them. An update banner is used while a turn, upload,
unacknowledged command, permission/question interaction or unsaved form makes
a refresh unsafe. Editor document and annotation queues protect pending saves
even when the Editor is not the current view. Refresh is not permission to
silently discard unsaved work. Repeated failure to adopt a build cannot produce
an automatic reload loop.

## One-time installation

The bootstrap itself changes release authority, so review and merge its PR
manually. Let the ordinary managed updater install that version first. It must
be serving the same compiled SHA as its clean managed source checkout.

Provide a dedicated GitHub credential restricted to **mikkokotila/Poise**, with
repository contents and pull-request write permission, and Actions/checks read
access. Keep it in a private user-owned file, not in chat, source, an agent
environment, or a command argument containing the token value. The controller
accepts the file path; it never sends the token to the implementing model.

```sh
npm run self-update:enable -- --token-file "$HOME/.poise/release-token" --dry-run
npm run self-update:enable -- --token-file "$HOME/.poise/release-token"
npm run self-update:doctor
```

The installer preserves the existing launchd environment and Caller pin,
stages the baseline without modifying its running bundle, and installs the
controller and stable launcher under `~/.poise/self-update/controller/`.
Bootstrap phases and failures are journaled. A failed bootstrap restores the
preserved service definition. Re-running the command reconciles an interrupted
attempt rather than guessing that it completed. The legacy updater yields to
the controller while installed; it cannot undo a rollback hold.

This is installation of the release mechanism, not a new approval step for
each Poise improvement. There is no requirement to add administrative branch
protection before the controller can enforce its checks. Existing GitHub
restrictions remain effective and are never bypassed.

For recovery even when the application is broken:

```sh
node "$HOME/.poise/self-update/controller/cli.mjs" status
node "$HOME/.poise/self-update/controller/cli.mjs" rollback --expected RELEASE_ID
```

The status command reports the recovery page address (normally loopback port
5556), the active/previous release, pending change, and any promotion hold.
Use `self-update:disable` for explicit maintenance; `self-update:uninstall`
returns ownership to the legacy updater only after disabling. Retained
artifacts, journals and persistent application data are not silently erased.

Two minutes is a target for small changes, not an excuse to skip checks or
interrupt active work. Build duration, CI queues, provider latency and safe
handover can make a change take longer.
