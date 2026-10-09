# convert

Convert 3D city models between **CityJSON**, **CityJSONSeq**, **FlatCityBuf** and
**CityParquet** in the browser. Drop a file (or paste a URL), pick the output format, levels
of detail and attributes, and download the result. Nothing is uploaded: the conversion runs
locally in [DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview) with the
[`cityjson`](https://github.com/cityjson/duckdb-cityjson) DuckDB extension.

> **Experimental.** In the browser, only conversion _to_ a CityParquet package works today.
> CityJSON, CityJSONSeq and FlatCityBuf output, and CityParquet package input, wait on fixes
> in the extension. See [docs/spike-findings.md](docs/spike-findings.md).

## Development

Requires [Vite+](https://viteplus.dev) (`vp`).

```sh
vp install
vp exec playwright install chromium   # once, for the browser smoke test
vp dev                                # http://localhost:5173/convert/
vp check && vp test                   # lint, types, unit, integration and browser tests
```

Design and architecture: [docs/idea.md](docs/idea.md). Working conventions:
[CLAUDE.md](CLAUDE.md).

## Branches

- `develop`: day-to-day work, push freely. CI runs on every push.
- `main`: releases. Updated only by merging `develop`; every push deploys to GitHub Pages.

## Data

The test fixture is a subset of the [3DBAG](https://3dbag.nl) Delft tile (CC BY 4.0).
