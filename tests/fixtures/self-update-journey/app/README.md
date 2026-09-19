# poise-journey-fixture

A zero-dependency stand-in for Poise used by `tests/poise-release-journey.test.mjs`.
The controller clones it from a temporary bare repository, runs `npm ci`,
`npm run check` and `npm run build` on it through the real release pipeline,
and the test starts the built `dist/server.js` from the active-release pointer.

- `src/greeting.mjs` — the behaviour a change edits.
- `src/server.mjs` — health with build identity, Chat session list, bridge-key
  protected readiness/drain/resume, plus a `POST /__fixture/busy` test hook.
- `scripts/build.mjs` — stamps `POISE_RELEASE_SHA` into one self-contained bundle,
  refusing a dirty checkout or a different HEAD, like Poise's own build.
- `package-lock.json` — present so `npm ci` succeeds offline; there is nothing to install.
