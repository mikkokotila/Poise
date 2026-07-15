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
