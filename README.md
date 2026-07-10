# Poise

A minimal local dashboard for your engineering work on GitHub — three views, one SQLite cache.

- **Main** — every issue and PR you're part of, with the latest commenter shown as an avatar, a play button to run a consensus review via [Confab](https://github.com/world-federation-of-advertisers/Confab), and an inline expand to preview the last comment.
- **Flow** — cycle time, throughput, first-review latency, waste, activity over time, work mix, top contributors, monthly waste bars.
- **Trust** — rework, silent merges, bounce, blast radius, review engagement, return-to-author, and file-level hotspots.

Built with Vite + TypeScript, no framework, no UI lib. All data is cached locally in SQLite (`~/.poise/cache.db`) — the GitHub API is hit only on sync.

## Setup

```bash
npm install
cp .env.example .env   # optional: CONFAB_API_KEY enables consensus reviews
npm run dev
```

Open http://localhost:5555. On first load the Settings panel opens automatically — paste a [GitHub classic PAT](https://github.com/settings/tokens/new?scopes=repo,read:org&description=Poise) with `repo` + `read:org` scopes and click Save. The token is stored locally in `~/.poise/cache.db` (meta table) and used only to call the GitHub API on your behalf.

After the first save, Poise runs an initial sync (a few minutes for a busy org). Subsequent loads delta-sync using GitHub's `updated:>` search operator and are near-instant.

## Architecture

- `src/` — three views (`main-view.ts`, `flow-view.ts`, `trust-view.ts`), a typography panel, a burger menu
- `server/` — Vite middleware (`cache-plugin.ts`), sync pipeline (`sync.ts`), SQLite schema (`db.ts`), dashboard queries (`queries.ts`)
- `~/.poise/cache.db` — local SQLite database, WAL mode

## Endpoints

**Auth**
- `GET  /api/auth/status` — is a token configured?
- `POST /api/auth/set-token` — `{ "token": "ghp_…" }` to save, `{ "token": "" }` to clear

**Cache**
- `POST /api/cache/sync` — delta sync from GitHub
- `POST /api/cache/backfill-files?limit=N` — one-shot backfill of file-level data (for Trust hotspots)
- `GET  /api/cache/prs?type=&status=&limit=&offset=` — paged list for Main
- `GET  /api/cache/flow?range=7|30|90|365` — Flow dashboard payload
- `GET  /api/cache/trust?range=7|30|90|365` — Trust dashboard payload

**GitHub proxy**
- `/api/github/*` — transparent proxy that injects the stored PAT as `Authorization: Bearer …`. Used for in-browser calls (e.g. posting PR review comments) without exposing the token to the browser.

## Configuration

The burger menu (top-right) has two settings panels:
- **Settings** — the GitHub PAT
- **Typography** — five preset archetypes (Engineer, Editor, Minimalist, Companion, Auteur) and full control over font size, line height, row density, colors, and content width.

Filters, typography preferences, and the selected view persist in `localStorage`. The GitHub token persists in the SQLite `meta` table.

## License

MIT
