# Bundled `dsh-api` plugin

This directory ships a copy of the [`dsh-api` plugin](https://github.com/lilming123/dsh-api) with the desktop app. On every launch, `src/dsh.js` copies `index.mjs` into `$DSH_HOME/profiles/web/dsh-api/` and writes a matching patch layer, then spawns dsh with `--patch` so the plugin is loaded.

- Upstream source: <https://github.com/lilming123/dsh-api>
- Route prefix: `/dsh-api` (see the upstream README for the full HTTP surface)
- Companion discovery file (written by this desktop app): `$DSH_HOME/dsh-api-companion.json`

Keeping the copy in-tree lets the desktop build stay self-contained. Bump the file to keep in sync with the upstream repo.
