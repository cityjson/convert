// Smoke test of the real browser stack: the pinned duckdb-wasm, the vendored extension
// binaries, and core's SQL. It is the test that catches a duckdb-wasm / extension
// version mismatch, which only shows up when the extension is LOADed.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { convert, inspect, type SourceInfo } from "@cityjson/cjconv-core";
import { createBrowserEngine, type BrowserEngine } from "@/engine/duckdb";
import { InputError, combineInputs, prepareInputs } from "@/features/convert/io";
import fixture from "../../../../fixtures/delft_subset.city.jsonl?raw";
import cubeMtl from "../../../../fixtures/cube.mtl?raw";
import cubeObj from "../../../../fixtures/cube.obj?raw";

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

describe("OBJ", () => {
  const OBJ = "input/obj/cube.obj";
  const CRS = { authority: "EPSG", code: "7415" };
  let obj: SourceInfo;

  beforeAll(async () => {
    // The .mtl sits beside the .obj, where read_obj looks for it.
    await engine.registerFile(OBJ, new TextEncoder().encode(cubeObj));
    await engine.registerFile("input/obj/cube.mtl", new TextEncoder().encode(cubeMtl));
    obj = await inspect(engine, {
      kind: "file",
      format: "obj",
      path: OBJ,
      options: { lod: "2.2", crs: CRS },
    });
  });

  it("inspects an OBJ with the caller's LoD and CRS", () => {
    expect(obj.schema.lods).toEqual(["2.2"]);
    expect(obj.crs).toEqual(CRS);
  });

  it("converts an OBJ to CityJSONSeq, carrying the caller's CRS", async () => {
    await convert(engine, {
      info: obj,
      target: "cityjsonseq",
      selection: { lods: ["2.2"], attributes: [] },
      output: "from_obj.city.jsonl",
    });
    const [row] = await engine.query(
      `SELECT count(*) AS n FROM read_cityjsonseq('from_obj.city.jsonl')`,
    );
    expect(row!.n).toBe(2);
    const [meta] = await engine.query(
      `SELECT reference_system.code AS code FROM cityjsonseq_metadata('from_obj.city.jsonl')`,
    );
    expect(meta!.code).toBe("7415");
  });

  it("converts an OBJ to a CityParquet package", async () => {
    const files = await convert(engine, {
      info: obj,
      target: "cityparquet",
      selection: { lods: ["2.2"], attributes: [] },
      output: "obj_pkg",
    });
    expect(files.map((f) => f.split("/").pop())).toContain("building.parquet");
    const [row] = await engine.query(
      `SELECT count(*) AS n FROM read_parquet('obj_pkg/building.parquet')`,
    );
    expect(row!.n).toBe(2);
  });

  it("writes CityJSONSeq as OBJ with its .mtl, which reads back", async () => {
    const files = await convert(engine, {
      info,
      target: "obj",
      selection: { lods: ["2.2"], attributes: [] },
      output: "out_obj/delft.obj",
    });
    const names = files.map((f) => f.split("/").pop());
    expect(names).toContain("delft.obj");
    expect(names).toContain("delft.mtl");
    for (const f of files) expect((await engine.readFile(f)).byteLength).toBeGreaterThan(10);
    // The OBJ writer skips objects with no geometry at the LoD it writes: in 3DBAG only
    // BuildingParts carry LoD 2.2, their parent Buildings none.
    const [expected] = await engine.query(
      `SELECT count(*) AS n FROM read_cityjsonseq('${INPUT}') WHERE geometry_lod2_2 IS NOT NULL`,
    );
    const [row] = await engine.query(
      `SELECT count(*) AS n FROM read_obj('out_obj/delft.obj', lod := '2.2')`,
    );
    expect(row!.n).toBe(expected!.n);
    expect(row!.n).toBeGreaterThan(0);
  });
});

describe("several files of one dataset", () => {
  const A = "tiles/a.city.jsonl";
  const B = "tiles/b.city.jsonl";
  const seq = (path: string) => ({ kind: "file" as const, format: "cityjsonseq" as const, path });

  beforeAll(async () => {
    const read = `read_cityjsonseq('${INPUT}')`;
    const firstTen = `(SELECT DISTINCT feature_id FROM ${read} ORDER BY feature_id LIMIT 10)`;
    await engine.exec(
      `COPY (SELECT * FROM ${read} WHERE feature_id IN ${firstTen}) TO '${A}' (FORMAT cityjsonseq, metadata_from '${INPUT}')`,
    );
    await engine.exec(
      `COPY (SELECT * FROM ${read} WHERE feature_id NOT IN ${firstTen}) TO '${B}' (FORMAT cityjsonseq, metadata_from '${INPUT}')`,
    );
  });

  it("combines them into one output", async () => {
    const merged = await inspect(engine, { kind: "merge", sources: [seq(A), seq(B)] });
    expect(merged.objects).toBe(OBJECTS);
    await convert(engine, {
      info: merged,
      target: "flatcitybuf",
      selection: { lods: ["2.2"], attributes: [] },
      output: "merged.fcb",
    });
    const [row] = await engine.query(`SELECT count(*) AS n FROM read_flatcitybuf('merged.fcb')`);
    expect(row!.n).toBe(OBJECTS);
  });

  it("refuses an object in two of them", async () => {
    const twice = await inspect(engine, { kind: "merge", sources: [seq(A), seq(A)] });
    await expect(
      convert(engine, {
        info: twice,
        target: "flatcitybuf",
        selection: { lods: ["2.2"], attributes: [] },
        output: "twice.fcb",
      }),
    ).rejects.toThrow(/duplicate id/i);
  });
});

describe("adding inputs one at a time (web)", () => {
  const tile = (name: string, text: string) =>
    new File([new TextEncoder().encode(text)], name, { type: "application/json" });

  it("keeps every input in its own place, and combines two into one merge", async () => {
    const [a] = await prepareInputs(engine, {
      kind: "files",
      files: [tile("a.city.jsonl", fixture)],
    });
    const [b] = await prepareInputs(engine, {
      kind: "files",
      files: [tile("b.city.jsonl", fixture)],
    });
    expect(a!.registered[0]).not.toBe(b!.registered[0]);

    const both = combineInputs([a!, b!]);
    expect(both.source.kind).toBe("merge");
    expect(both.parts).toHaveLength(2);
    expect(both.bytes).toBe(a!.bytes + b!.bytes);
    // Both are the same tile, so the merge itself is refused at conversion.
    const info = await inspect(engine, both.source);
    await expect(
      convert(engine, {
        info,
        target: "cityjsonseq",
        selection: { lods: ["2.2"], attributes: [] },
        output: "same_twice.city.jsonl",
      }),
    ).rejects.toThrow(/duplicate id/i);
  });

  it("refuses to combine an OBJ with other files", async () => {
    const [seqInput] = await prepareInputs(engine, {
      kind: "files",
      files: [tile("c.city.jsonl", fixture)],
    });
    const [objInput] = await prepareInputs(engine, {
      kind: "files",
      files: [tile("cube.obj", cubeObj)],
    });
    expect(() => combineInputs([seqInput!, objInput!])).toThrow(InputError);
  });
});
