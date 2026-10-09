# convert

Browser-based converter between 3D city model formats. Design and rationale: [docs/idea.md](docs/idea.md).

v1 formats: CityJSON (`.city.json`), CityJSONSeq (`.city.jsonl`), FlatCityBuf (`.fcb`), and the
CityParquet package (a directory; it arrives as a folder or `.zip` and is downloaded as `.zip`).
Later: CityGML 2.0/3.0, OBJ, glTF. Those are blocked on extension support, so don't stub them.

## The one rule

**This repo contains no format readers or writers.** All parsing and serialisation happen in the
[`cityjson`](https://github.com/cityjson/duckdb-cityjson) DuckDB extension, running in the
browser through duckdb-wasm. The app inspects the input, generates SQL (`COPY … TO`, or
`PRAGMA insert_*` → `cityparquet_write` for packages), and moves bytes. If a conversion needs
something the extension can't do, fix it upstream in the extension. Don't work around it here.

The extension's function reference is `docs/FUNCTIONS.md` in its repo. Read it before writing SQL.

## Stack

- React + TypeScript, shadcn/ui (Tailwind), themed with the CityJSON design system (light-only).
- Vite+ (`vp`) is the single toolchain: dev server, build, Vitest, Oxlint, Oxfmt.
- `@duckdb/duckdb-wasm`, eh bundle, single-threaded (GitHub Pages can't send COOP/COEP).
- Deployed to GitHub Pages under `base: '/convert/'`.

## Commands

```sh
vp install                               # install deps (pnpm version is pinned via devEngines)
vp exec playwright install chromium      # once, for the browser smoke test
vp dev                                   # dev server → http://localhost:5173/convert/
vp check                                 # format + lint + type check
vp test                                  # node project (unit + integration) and browser project
vp run check:lockstep                    # duckdb-wasm ↔ vendored extension versions
vp run vendor:ext [cityjson=<file>]      # re-download / replace vendored extension binaries
vp build                                 # production build into dist/
```

Use `vp`, not `npm`/`npx`: `devEngines` pins pnpm and npm refuses to run here.

## Architecture

```
src/core/              pure TS: formats, detect, schema, sql, crs, Engine interface, convert (orchestrator)
src/engine/            duckdb-wasm Engine + browser file I/O (register, read, drop, terminate)
src/features/convert/  the single UI flow: Source → Options → Convert; io.ts turns drops/URLs into files
src/components/ui/     shadcn components (add more with `vp dlx shadcn@<ver> add …`)
src/styles/theme.css   CityJSON tokens → shadcn CSS variables
public/duckdb-ext/     manifest.json + vendored extension binaries, pinned
tests/integration/     core against native DuckDB (@duckdb/node-api) + cityjson
tests/browser/         duckdb-wasm smoke test in headless Chromium
```

`Engine` (core) is SQL only: `query` and `exec`. Getting bytes in and out is the runtime
adapter's job. URLs are fetched by the app and registered as buffers, not read by the extension.

Dependency direction is one-way: `features → engine → core`. **`src/core` must not import
React, DOM APIs or duckdb.** That keeps it unit-testable and reusable by a future CLI with a
`@duckdb/node-api` Engine. Lint enforces the boundary.

## Invariants

- **Version lockstep.** duckdb-wasm rejects an extension whose DuckDB version footer differs
  from its own. The exact `@duckdb/duckdb-wasm` pin in `package.json` and the vendored
  `public/duckdb-ext/<duckdb-version>/wasm_eh/` directory move together, in one commit. CI
  checks this. Never use a caret range for duckdb-wasm.
- **Extensions are vendored, never loaded from the community CDN at runtime.** The CDN path
  has no extension version in it, so a new release would change behaviour without a deploy.
  Today both `cityjson` (`a1455e1`) and `parquet` are the official signed v1.5.6 builds
  (`allowUnsignedExtensions` stays off). `parquet` is vendored because a custom repository
  breaks autoloading. The community build for DuckDB v1.5.4 is frozen at an older commit, so
  don't go back to v1.5.4.
- **Selection semantics.** LoD filtering keeps only the chosen `*_lodX_Y` column groups (the
  reader's `lod =>` accepts a single LoD only). Attribute filtering only ever drops attribute
  columns. Never drop `id`, `feature_id`, `object_type`, `children`, `children_roles`,
  `parents`, `address`, `template`, `other`, geometry, property, material or texture columns,
  or `bbox`.
- **Always pass `metadata_from`** for a file source, so CRS and appearance don't depend on
  the extension inferring the source. For package sources, pass `crs` from the footer.
- **One PRAGMA per statement.** DuckDB expands every pragma in a batch before running any
  of it. Package creation seeds `building` (`LIMIT 0`) before `cityparquet_init`/`insert_*`.
- **Known extension bugs in wasm** are in [docs/spike-findings.md](docs/spike-findings.md).
  Fix them upstream; don't work around them in this repo. `tests/browser/engine.test.ts`
  marks them `it.fails`; when a fixed build is vendored they turn red, which is the cue to
  flip them to `it`.
- **Free memory.** Drop virtual-FS files after download. A fatal wasm error discards the
  worker (`terminate()`), and the next action starts a fresh one.
- **`registerFile` transfers the buffer** to the worker: measure or copy it first.

## Workflow

- Branches: `develop` is the integration branch and can be pushed to freely. `main` is the
  release branch, updated only by merging `develop`. Each push to `main` deploys to Pages.
- Write tests first for anything in `src/core`. Integration tests run the generated SQL against
  the real extension through `@duckdb/node-api`.
- Run `vp check && vp test` before claiming work is done.
- Keep the UI minimal: one screen, three steps. Don't add features the flow doesn't need.
