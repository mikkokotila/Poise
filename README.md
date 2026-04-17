# Poise

A minimal local dashboard for your engineering work on GitHub — three views, one SQLite cache.

- **Main** — every issue and PR you're part of, with the latest commenter shown as an avatar, a play button to run a consensus review via [Confab](https://github.com/world-federation-of-advertisers/Confab), and an inline expand to preview the last comment.
- **Flow** — cycle time, throughput, first-review latency, waste, activity over time, work mix, top contributors, monthly waste bars.
- **Trust** — rework, silent merges, bounce, blast radius, review engagement, return-to-author, and file-level hotspots.

Built with Vite + TypeScript, no framework, no UI lib. All data is cached locally in SQLite (`~/.poise/cache.db`) — the GitHub API is hit only on sync.

## Setup

```bash
npm install
cp .env.example .env   # add your CONFAB_API_KEY if you want consensus reviews
npm run dev
```

Auth uses the `gh` CLI — make sure `gh auth token` works.

The first load triggers an initial sync (a few minutes for a busy org). Subsequent loads delta-sync using GitHub's `updated:>` search operator.

## Architecture

- `src/` — three views (`main-view.ts`, `flow-view.ts`, `trust-view.ts`), a typography panel, a burger menu
- `server/` — Vite middleware (`cache-plugin.ts`), sync pipeline (`sync.ts`), SQLite schema (`db.ts`), dashboard queries (`queries.ts`)
- `~/.poise/cache.db` — local SQLite database, WAL mode

## Endpoints

- `POST /api/cache/sync` — delta sync from GitHub
- `POST /api/cache/backfill-files?limit=N` — one-shot backfill of file-level data (for Trust hotspots)
- `GET /api/cache/prs?type=&status=&limit=&offset=` — paged list for Main
- `GET /api/cache/flow?range=7|30|90|365` — Flow dashboard payload
- `GET /api/cache/trust?range=7|30|90|365` — Trust dashboard payload

## Configuration

Filters, typography preferences, and the selected view persist in `localStorage`. Typography has five preset archetypes (Engineer, Editor, Minimalist, Companion, Auteur) and full control over font size, line height, row density, colors, and content width.

## License

MIT
