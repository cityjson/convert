# convert

Browser-based converter between 3D city model formats. Design and rationale: [docs/idea.md](docs/idea.md).

Formats: CityJSON (`.city.json`), CityJSONSeq (`.city.jsonl`), FlatCityBuf (`.fcb`), OBJ
(`.obj` with its `.mtl` and textures; in and out as a set, zipped on download), and the
CityParquet package (a directory; it arrives as a folder or `.zip` and is downloaded as `.zip`).
OBJ states no LoD or CRS: the user supplies them (`read_obj(lod := …)`, `obj_metadata(crs := …)`).
Later: glTF/GLB (the extension writes them, but not yet through DuckDB's file system) and
CityGML 2.0/3.0 (no extension support). Don't stub them.

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
vp exec --filter @cityjson/cjconv-web playwright install chromium   # once, for the browser smoke test
vp run dev                               # web dev server → http://localhost:5173/convert/
vp check                                 # format + lint + type check, whole workspace
vp test                                  # every project: core, cjconv (native), web (browser)
vp test --project cjconv                 # one project
vp run -r build                          # vp pack the packages, vp build the website
vp run check:lockstep                    # duckdb-wasm ↔ vendored extension versions
node packages/cjconv/dist/cli.mjs …      # the built CLI
```

Use `vp`, not `npm`/`npx`: `devEngines` pins pnpm and npm refuses to run here.

## Architecture

A pnpm workspace (see [docs/cli.md](docs/cli.md)):

```
packages/core/    @cityjson/cjconv-core  pure TS: formats, detect, schema, sql, crs, Engine
                                         interface, inspect/convert. Unit tests. Published to npm.
packages/cjconv/  @cityjson/cjconv       Node Engine (@duckdb/node-api), convertFile/inspectFile,
                                         the `cjconv` CLI (src/main.ts; src/cli.ts is the bin).
                                         Integration + CLI tests. Published to npm.
apps/web/         private                the website: React + duckdb-wasm; src/engine is its
                                         Engine; scripts/ + public/duckdb-ext are the vendoring.
fixtures/         shared test data
```

`Engine` (core) is SQL only: `query` and `exec`, returning plain-JSON rows (BIGINT as
number). Getting bytes in and out is each runtime's job: the web app registers buffers
(it fetches URLs itself); cjconv lets native DuckDB read paths and URLs directly.

Dependency direction is one-way: `apps/web → core`, `cjconv → core`. **`packages/core` must
not import React, DuckDB or Node APIs**; lint enforces it. In the repo, web and cjconv import
`@cityjson/cjconv-core` from source (Vite alias + TS path); published, from its `dist`.

## Invariants

- **Version lockstep.** duckdb-wasm rejects an extension whose DuckDB version footer differs
  from its own. The exact `@duckdb/duckdb-wasm` pin in `package.json` and the vendored
  `public/duckdb-ext/<duckdb-version>/wasm_eh/` directory move together, in one commit. CI
  checks this. Never use a caret range for duckdb-wasm.
- **Extensions are vendored, never loaded from the community CDN at runtime.** The CDN path
  has no extension version in it, so a new release would change behaviour without a deploy.
  `parquet` is the official signed v1.5.6 build. `cityjson` is **self-built** from
  duckdb-cityjson `e43c986` (the wasm I/O fixes of #23 and the OBJ writer on DuckDB's file system) for v1.5.6, because the community build
  is still `a1455e1`. Self-built means unsigned, so the engine opens with
  `allowUnsignedExtensions: true`. Once the community repository publishes a fixed v1.5.6
  build, re-vendor it with `vp run vendor:ext` and turn the flag back off. `parquet` is vendored because a custom repository
  breaks autoloading. The community build for DuckDB v1.5.4 is frozen at an older commit, so
  don't go back to v1.5.4.
- **Selection semantics.** LoD filtering keeps only the chosen `*_lodX_Y` column groups (the
  reader's `lod =>` accepts a single LoD only). Attribute filtering only ever drops attribute
  columns. Never drop `id`, `feature_id`, `object_type`, `children`, `children_roles`,
  `parents`, `address`, `template` / `implicit_geometry`, `other`, geometry, property, material or texture columns,
  or `bbox`.
- **Always pass `metadata_from`** for a file source, so CRS and appearance don't depend on
  the extension inferring the source. For package sources, pass `crs` from the footer.
- **One PRAGMA per statement.** DuckDB expands every pragma in a batch before running any
  of it. Package creation seeds `building` (`LIMIT 0`) before `cityparquet_init`/`insert_*`.
- **Known extension bugs in wasm** are in [docs/spike-findings.md](docs/spike-findings.md).
  Bugs 1–4 are fixed in the vendored build, and `tests/browser/engine.test.ts` guards each
  one. Fix future extension bugs upstream; don't work around them in this repo.
- **Merges refuse, never guess.** Several inputs (`Source` kind `merge`) are combined only
  when ids are unique across them, the CRS is the same and shared columns hold the same
  kind of values (inference differences are reconciled: widest number; text that all
  casts to the other type); appearances across inputs are refused. A missing column is
  NULL, never an error.
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

## Releasing to npm

`@cityjson/cjconv-core` and `@cityjson/cjconv` share one version, set only by the
**Publish to npm** workflow (`.github/workflows/publish.yml`), run by hand from `main`
with a `patch` / `minor` / `major` bump (and an optional dry run). It tests the packages,
bumps both versions (`scripts/bump-version.mjs`), publishes with provenance, pushes a
`release: vX.Y.Z` commit and `vX.Y.Z` tag to `main`, and merges that commit back into
`develop`. When it succeeds, the **release** workflow creates the GitHub release for the
latest npm version, with both tarballs attached. Don't edit the package versions by hand.
Needs the `NPM_TOKEN` repository secret and the `@cityjson` npm org.
