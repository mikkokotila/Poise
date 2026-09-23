# Provider CLI and model freshness

Poise updates installed provider CLIs before model discovery and checks the
selected provider before native Chat startup and each subsequent turn. A
running answer is never restarted for an update. At the next turn boundary,
a changed CLI version resumes the same native conversation on the new binary.
Steering and permission answers do not start another update.

The policy is to use the latest release, not a version pinned when Poise was
built. The Claude SDK remains a tested protocol dependency; its bundled CLI is
not used. Poise's subscription wrapper launches the standalone Claude executable.

## Updating and discovery

Settings → Models → **Check now** and the existing scheduled model check run
`scripts/refresh-models.mjs`. Both perform the same sequence:

1. Update installed Claude, Codex, Grok, Antigravity and Muse CLIs concurrently.
2. Read the actual launcher's version again, detecting duplicate-install issues.
3. Ask Caller's release-managed `agent-interface --refresh-models` for models.
4. Atomically record the CLI results and per-provider discovery results, then
   invalidate Poise's model cache.

Claude uses `claude install latest`. npm-installed Codex is updated with
`@openai/codex@latest` in its existing global prefix, including optional native
packages; other Codex installations use `codex update`. Grok and Antigravity
use their update commands. Muse's launcher performs a synchronous update; its
release build is checked as well as its semantic version.

Overlapping requests share a check. Separate Poise processes serialize updates
for each launcher and discovery for the shared report. A subsequent launch
checks again rather than trusting a time-to-live cache. Updaters receive only
installation/network environment variables, not model prompts or API tokens.
Only the selected provider is maintained on a native Chat turn. Caller-backed
card/editor chat, reviews, approvals, content and debate maintain their selected
providers before launch too. No unrelated packages or IDE bundles are upgraded.

## Failure and recovery

A CLI check has a two-minute total budget, including lock acquisition and
version probes. Discovery has a ten-minute deadline. The enclosing manual check
and browser request also have deadlines; Checking cannot remain disabled
indefinitely. A terminated standalone refresh runner kills its updater groups.

Offline, authentication, permissions or installation failures are not reported
as a verified latest version. Existing installed CLIs remain usable with a
visible Chat warning, and a later turn retries. A failed model check preserves
existing choices and reports the affected CLI/provider instead of claiming
“nothing new.” Missing providers are not installed implicitly.

The Settings view shows elapsed time while checking, then versions and the
completed result. Refreshing the catalogue updates an untouched fresh console
to the latest discovered Opus with High effort. Explicit model selections and
existing conversations are not silently moved to another model.

## Verification

Tests use isolated executables and version files, never the user's installations.
They cover updater ordering, shared checks, npm prefixes, Muse release builds,
failed discovery receipts, retry, cancellation/cleanup, native resume between
turns, catalogue invalidation, new-model defaults and browser timeout recovery.

Upgrade compatibility: older pages stored the fixed `opus-5-high` fresh-console
default without recording whether it was explicitly chosen. That legacy value
now restores as automatic Opus High, with draft text preserved. New snapshots
record automatic versus explicit selection, so future reloads preserve a
person's intentional model choice. Existing sessions retain their selected model.
