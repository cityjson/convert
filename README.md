# convert

Convert 3D city models between **CityJSON**, **CityJSONSeq**, **FlatCityBuf**, **OBJ** and
**CityParquet** in the browser and on the command line. Drop a file (or paste a URL), pick the output format, levels
of detail and attributes, and download the result. Nothing is uploaded: the conversion runs
locally in [DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview) with the
[`cityjson`](https://github.com/cityjson/duckdb-cityjson) DuckDB extension.

> **Experimental.** The extension is under active development; verify results before
> relying on them. Everything is held in memory, so very large files may not fit.

## Command line and library

[`@cityjson/cjconv`](packages/cjconv) is the same conversion as a CLI and Node library:

```sh
cjconv delft.city.jsonl delft.fcb --lod 2.2
cjconv info delft.city.jsonl
```

## Development

A pnpm workspace: `packages/core` (`@cityjson/cjconv-core`), `packages/cjconv`
(`@cityjson/cjconv`, the CLI) and `apps/web` (this website). Requires
[Vite+](https://viteplus.dev) (`vp`).

```sh
vp install
vp exec --filter @cityjson/cjconv-web playwright install chromium   # once, for the browser smoke test
vp run dev                                        # http://localhost:5173/
vp check && vp test                               # lint, types, unit, integration, CLI and browser tests
vp run -r build                                   # pack the npm packages, build the website
```

Design and architecture: [docs/idea.md](docs/idea.md) and [docs/cli.md](docs/cli.md).
Working conventions: [CLAUDE.md](CLAUDE.md).

## Releases

The npm packages are published by the **Publish to npm** workflow (run it from `main`,
choosing a patch, minor or major bump). The **release** workflow then creates the
matching GitHub release.

## Branches

- `develop`: day-to-day work, push freely. CI runs on every push.
- `main`: releases. Updated only by merging `develop`; every push deploys to GitHub Pages.

## Data

The test fixture is a subset of the [3DBAG](https://3dbag.nl) Delft tile (CC BY 4.0).

## License

[MIT](LICENSE). The vendored DuckDB extensions and duckdb-wasm carry their own (MIT) licenses.
