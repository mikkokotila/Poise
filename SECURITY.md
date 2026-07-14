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
