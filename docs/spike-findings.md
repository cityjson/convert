# Spike: the `cityjson` extension in duckdb-wasm

Date: 2026-10-09. The spike code was throwaway and is not in this repo.

**Question.** Can the `cityjson` extension, loaded into `@duckdb/duckdb-wasm@1.33.1-dev57.0`
(DuckDB v1.5.4, eh bundle, Chromium), do every read and write the app needs?

**Answer.** Reading works for in-memory inputs. **Writing does not work in wasm at all.**
Several extension bugs, listed below, block it. Every path works with native DuckDB
(v1.5.5, extension `a1455e1`).

## Results

Extension build: the `wasm_eh` CI artifact of `duckdb-cityjson` v0.4.0 (`a1455e1`).

| Case | Result |
| ---- | ------ |
| `LOAD cityjson` from a same-origin `custom_extension_repository` | ✅ 60 ms (needs `allowUnsignedExtensions: true`, because CI artifacts are unsigned) |
| `DESCRIBE` / `cityjsonseq_metadata` on a remote `.city.jsonl` | ✅ |
| `read_cityjson` on a remote `.city.json` | ❌ bug 2 |
| `read_cityjsonseq` / `read_cityjson` / `read_flatcitybuf` on `registerFileBuffer` input | ✅ 2231 rows each |
| `read_flatcitybuf` remote with bbox (HTTP range) | ✅ 32 ms |
| `read_cityjsonseq` on `registerFileHandle` (`BROWSER_FILEREADER`) input | ❌ hangs, bug 3 |
| `COPY … TO (FORMAT cityjson \| cityjsonseq \| flatcitybuf)` | ❌ 1-byte output, bug 1 |
| `cityparquet_write` | ❌ `parquet` autoload fails (a setup issue, see below), then bug 1-class risk |
| `cityparquet_read` on registered files | ❌ bug 4 |
| Plain DuckDB `COPY … TO 'x.csv'` and `read_text` on a file handle | ✅, so these are extension bugs, not duckdb-wasm bugs |

### Setup findings (our side)

- **The community CDN build is stale.** `community-extensions.duckdb.org/v1.5.4/wasm_eh/cityjson…`
  serves `d511bdb`, which has no FlatCityBuf and no CityParquet package functions. That's
  despite `description.yml` pinning `a1455e1`, so the community wasm build probably failed or
  didn't re-run. We vendor from the extension's own CI or release assets instead, which
  needs `allowUnsignedExtensions: true` (acceptable because the files are same-origin).
- **`parquet` must be vendored as well** (`extensions.duckdb.org/v1.5.4/wasm_eh/parquet…`).
  Pointing `custom_extension_repository` at our origin breaks autoloading from the default
  repository.
- **Package creation** needs the schema seeded with an object table before
  `PRAGMA insert_*` (`create_tables = true` cannot bootstrap an empty schema, despite what
  FUNCTIONS.md says). Each `PRAGMA` must be its own statement.
- **The reader's `lod =>` takes one LoD.** To keep several LoDs, select their column groups instead.
- The predefined columns also include `address` and `template`.

## Upstream bugs in `duckdb-cityjson`

### Bug 1: writers bypass DuckDB's FileSystem (blocks all writes in wasm)

`src/cityjson/cityjson_writer.cpp:254, 270, 506` open the output with `std::ofstream`.
In wasm that writes into Emscripten's own MEMFS, not DuckDB's virtual FS, so the `COPY`
target is left empty.

```sql
COPY (SELECT * FROM read_cityjsonseq('in.city.jsonl') LIMIT 5) TO 'o.city.jsonl' (FORMAT cityjsonseq);
SELECT length(content) FROM read_text('o.city.jsonl');   -- 1 in wasm
```

**Fix:** write through `FileSystem::OpenFile(path, FILE_FLAGS_WRITE | FILE_FLAGS_FILE_CREATE_NEW)`
plus `Write`, as `cityparquet_write.cpp:737` already does. This applies to all three formats,
including the FlatCityBuf writer.

### Bug 2: single-shot read returns NUL bytes over HTTP

`src/cityjson/json_utils.cpp` `ReadFileContent` calls `handle->Read(buf, file_size)` once.
In wasm, the HTTP file system returns a short read (16 KB), so the rest of the buffer is left
as NUL bytes.

```
read_cityjson('https://…/delft.city.json')
→ Failed to parse JSON: … column 16385: control character U+0000 (NUL)
```

**Fix:** loop until `file_size` bytes have been read, using the `Read` overload that returns
the byte count.

### Bug 3: `read_cityjsonseq` never terminates on browser file handles

`src/cityjson/local_cityjsonseq_reader.cpp:118-130` treats an empty `ReadLine()` as EOF only
when `GetFileSize() == SeekPosition()`. On a `BROWSER_FILEREADER` handle the condition
apparently never holds, so the loop spins on empty lines forever. This is **likely, not yet
proven**: the loop pattern matches the symptom, but the handle state hasn't been traced.

**Fix:** treat repeated empty reads at a non-advancing position as EOF, or track the position
explicitly.

### Bug 4: `cityparquet_read` requires a real directory

`PRAGMA cityparquet_read('pkgin', 'src')` → `no such directory 'pkgin'` when the files were
registered as `pkgin/building.parquet` and `pkgin/metadata.json`. Wasm registered files have
no directory entries.

**Fix:** list the files with a glob (`pkgin/*.parquet`) instead of a directory check, or
accept an explicit file list.

### Bug 5 (minor): `metadata_from` on a `.city.jsonl`, writing `FORMAT cityjson`

This logs `could not read metadata from source '….city.jsonl': Failed to parse JSON … line 2`.
CRS, title and contact still arrive, so some code path parses the CityJSONSeq source as a
single CityJSON document, probably the appearance loader. Appearance from a CityJSONSeq
source may be lost when the output is CityJSON. This is untested, because the Delft sample
has no appearance.

### Doc mismatch

FUNCTIONS.md documents `PRAGMA insert_cityjson(…, create_tables = true)` as creating module
tables in an empty schema. In fact it fails with `schema has no CityParquet object table`.
`test/sql/cityparquet_insert_fcb.test` already notes this.

## Native workarounds that are verified

```sql
-- file → package
CREATE SCHEMA outp;
CREATE TABLE outp.building AS SELECT * FROM read_cityjsonseq('<src>') LIMIT 0;
PRAGMA cityparquet_init('outp');
PRAGMA insert_cityjsonseq('outp', '<src>', create_tables = true);
SELECT * FROM cityparquet_write('outp', 'pkg/', source_format => 'cityjsonseq', crs => 'EPSG:7415');
-- → building.parquet (2231 rows), metadata.json

-- package → file  (CRS from the footer's PROJJSON id)
PRAGMA cityparquet_read('pkg', 'src');
COPY (SELECT * FROM src.building) TO 'out.city.jsonl'
  (FORMAT cityjsonseq, crs 'https://www.opengis.net/def/crs/EPSG/0/7415');
```

Timings: `DESCRIBE` on 6.6 MB of CityJSONSeq takes 0.17 s natively, so inspecting is cheap.
