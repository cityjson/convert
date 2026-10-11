# @cityjson/cjconv-core

The engine-agnostic core of [cjconv](https://github.com/cityjson/convert): format
detection, column selection and the SQL that the
[`cityjson`](https://github.com/cityjson/duckdb-cityjson) DuckDB extension runs to convert
between CityJSON, CityJSONSeq, FlatCityBuf, CityParquet packages and OBJ.

It contains no DuckDB binding. Supply an `Engine` (`query` and `exec` over SQL) backed by
`@duckdb/node-api`, duckdb-wasm or anything else that has the `cityjson` extension loaded.
For a ready-made Node API and CLI, use [`@cityjson/cjconv`](../cjconv).

```ts
import { inspect, convert } from "@cityjson/cjconv-core";

const info = await inspect(engine, {
  kind: "file",
  format: "cityjsonseq",
  path: "delft.city.jsonl",
});
await convert(engine, {
  info,
  target: "flatcitybuf",
  selection: { lods: ["2.2"], attributes: [] },
  output: "delft.fcb",
});
```

MIT licensed.
