// Smoke test of the real browser stack: the pinned duckdb-wasm, the vendored extension
// binaries, and core's SQL. It is the test that catches a duckdb-wasm / extension
// version mismatch, which only shows up when the extension is LOADed.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { convert, inspect, type SourceInfo } from "@/core/convert";
import { createBrowserEngine, type BrowserEngine } from "@/engine/duckdb";
import fixture from "../fixtures/delft_subset.city.jsonl?raw";

const OBJECTS = 40;
const INPUT = "input/delft.city.jsonl";

let engine: BrowserEngine;
let info: SourceInfo;
// Served from public/, exactly as the app sees it.
let manifest: { duckdb: string; extensions: { cityjson: { version: string } } };

beforeAll(async () => {
  manifest = await (await fetch(`${import.meta.env.BASE_URL}duckdb-ext/manifest.json`)).json();
  engine = await createBrowserEngine();
  await engine.registerFile(INPUT, new TextEncoder().encode(fixture));
  info = await inspect(engine, { kind: "file", format: "cityjsonseq", path: INPUT });
});

afterAll(async () => {
  await engine?.terminate();
});

describe("duckdb-wasm with the vendored extensions", () => {
  it("runs the DuckDB version the extensions were built for", async () => {
    const [row] = await engine.query("PRAGMA version");
    expect(row!.library_version).toBe(manifest.duckdb);
  });

  it("loads the vendored cityjson build", async () => {
    const rows = await engine.query(
      "SELECT extension_name, extension_version FROM duckdb_extensions() WHERE loaded",
    );
    const cityjson = rows.find((r) => r.extension_name === "cityjson");
    expect(cityjson?.extension_version).toBe(manifest.extensions.cityjson.version);
    expect(rows.map((r) => r.extension_name)).toContain("parquet");
  });

  it("inspects an in-memory CityJSONSeq file", () => {
    expect(info.schema.lods).toEqual(["0.0", "1.2", "1.3", "2.2"]);
    expect(info.crs).toEqual({ authority: "EPSG", code: "7415" });
  });

  it("writes a CityParquet package", async () => {
    const files = await convert(engine, {
      info,
      target: "cityparquet",
      selection: { lods: ["2.2"], attributes: ["status"] },
      output: "out_pkg",
    });
    expect(files.map((f) => f.split("/").pop() ?? "").sort((a, b) => a.localeCompare(b))).toEqual([
      "building.parquet",
      "metadata.json",
    ]);
    const parquet = await engine.readFile(files.find((f) => f.endsWith(".parquet"))!);
    expect(parquet.byteLength).toBeGreaterThan(1000);
    const [row] = await engine.query(
      `SELECT count(*) AS n FROM read_parquet('out_pkg/building.parquet')`,
    );
    expect(row!.n).toBe(OBJECTS);
  });

  // Regression tests for the extension's wasm I/O bugs (docs/spike-findings.md),
  // fixed in duckdb-cityjson#23.
  it.each([
    ["cityjson", "out.city.json", "read_cityjson"],
    ["cityjsonseq", "out.city.jsonl", "read_cityjsonseq"],
    ["flatcitybuf", "out.fcb", "read_flatcitybuf"],
  ] as const)("writes %s and reads it back (bug 1)", async (target, output, reader) => {
    const [file] = await convert(engine, {
      info,
      target,
      selection: { lods: ["2.2"], attributes: ["status"] },
      output,
    });
    expect((await engine.readFile(file!)).byteLength).toBeGreaterThan(1000);
    const [row] = await engine.query(`SELECT count(*) AS n FROM ${reader}('${output}')`);
    expect(row!.n).toBe(OBJECTS);
  });

  it("reads a package from registered files and converts it to a file (bug 4)", async () => {
    const pkg = await inspect(engine, { kind: "package", dir: "out_pkg" });
    expect(pkg.tables).toEqual(["building"]);
    expect(pkg.crs).toEqual({ authority: "EPSG", code: "7415" });
    await convert(engine, {
      info: pkg,
      target: "cityjsonseq",
      selection: { lods: pkg.schema.lods, attributes: [] },
      output: "from_pkg.city.jsonl",
    });
    const [row] = await engine.query(
      `SELECT count(*) AS n FROM read_cityjsonseq('from_pkg.city.jsonl')`,
    );
    expect(row!.n).toBe(OBJECTS);
  });
});
