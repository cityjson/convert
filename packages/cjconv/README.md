# @cityjson/cjconv

Convert 3D city models between **CityJSON**, **CityJSONSeq**, **FlatCityBuf**,
**CityParquet** packages and **OBJ**, keeping only the levels of detail and attributes you
need. A command line (`cjconv`) and a Node library, powered by the
[`cityjson`](https://github.com/cityjson/duckdb-cityjson) DuckDB extension through
`@duckdb/node-api`. A browser version lives at <https://cityjson.github.io/convert/>.

> Experimental: verify results before relying on them.

## Command line

```sh
npm install -g @cityjson/cjconv

cjconv delft.city.jsonl delft.fcb                          # format from the output name
cjconv delft.city.jsonl delft.city.json --lod 2.2 --attributes status
cjconv delft.city.jsonl delft_pkg/                         # CityParquet package (a directory)
cjconv delft_pkg delft.city.jsonl
cjconv https://cityjson.open3d.city/cityjsonseq/delft.city.jsonl delft.fcb
cjconv info delft.city.jsonl                               # format, CRS, LoDs, attributes
cjconv tile-1.city.jsonl tile-2.city.jsonl delft.fcb       # combine tiles into one output
cjconv --help
```

On first use the `cityjson` extension is installed from DuckDB's community repository
(network access needed once; it is cached in `~/.duckdb`). `--extension <path>` loads a
local build instead.

**OBJ** needs a `cityjson` build newer than the community one, which predates OBJ support:
pass `--extension`. An OBJ states no LoD or CRS, so give them:
`cjconv cube.obj cube.city.jsonl --obj-lod 2.2 --crs EPSG:7415`.

Several inputs are pieces of one dataset, combined into the one output (the last
argument). An id in more than one input, a column typed differently between inputs, or
inputs in different CRSs are refused rather than guessed at.

## Library

```ts
import { convertFile, inspectFile } from "@cityjson/cjconv";

const info = await inspectFile("delft.city.jsonl");
console.log(info.schema.lods, info.crs);

const { files } = await convertFile({
  input: "delft.city.jsonl",
  output: "delft.fcb",
  lods: ["2.2"],
  attributes: ["status"],
});

// Several tiles into one file
await convertFile({ input: ["tile-1.city.jsonl", "tile-2.city.jsonl"], output: "delft.fcb" });
```

For several conversions, create one engine with `createNodeEngine()` and pass it as
`engine` to avoid loading the extension each time. The engine-agnostic logic underneath is
[`@cityjson/cjconv-core`](https://www.npmjs.com/package/@cityjson/cjconv-core).

MIT licensed.
