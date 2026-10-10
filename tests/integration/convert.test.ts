// Runs the core orchestrator against the real cityjson extension (native DuckDB).
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { convert, inspect, type SourceInfo } from "../../src/core/convert";
import { createNodeEngine, type NodeEngine } from "../support/node-engine";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/delft_subset.city.jsonl");
const OBJECTS = 40; // 20 Buildings + 20 BuildingParts

let engine: NodeEngine;
let dir: string;
const out = (name: string) => path.join(dir, name);

async function count(sql: string): Promise<number> {
  const [row] = await engine.query(sql);
  return Number(Object.values(row!)[0]);
}

async function columns(relation: string): Promise<string[]> {
  return (await engine.query(`DESCRIBE SELECT * FROM ${relation}`)).map((r) =>
    String(r.column_name),
  );
}

beforeAll(async () => {
  engine = await createNodeEngine();
  dir = mkdtempSync(path.join(tmpdir(), "convert-it-"));
});

afterAll(() => {
  engine?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("inspect", () => {
  it("reports LoDs, attributes and CRS of a CityJSONSeq file", async () => {
    const info = await inspect(engine, { kind: "file", format: "cityjsonseq", path: FIXTURE });
    expect(info.schema.lods).toEqual(["0.0", "1.2", "1.3", "2.2"]);
    expect(info.schema.attributes.map((a) => a.name)).toContain("status");
    expect(info.schema.attributes.map((a) => a.name)).not.toContain("feature_id");
    expect(info.crs).toEqual({ authority: "EPSG", code: "7415" });
  });
});

describe("file → file", () => {
  let seq: SourceInfo;
  beforeAll(async () => {
    seq = await inspect(engine, { kind: "file", format: "cityjsonseq", path: FIXTURE });
  });

  it("CityJSONSeq → CityJSON keeps only the chosen LoD and attribute", async () => {
    const files = await convert(engine, {
      info: seq,
      target: "cityjson",
      selection: { lods: ["2.2"], attributes: ["status"] },
      output: out("subset.city.json"),
    });
    expect(files).toEqual([out("subset.city.json")]);

    const relation = `read_cityjson('${out("subset.city.json")}')`;
    expect(await count(`SELECT count(*) FROM ${relation}`)).toBe(OBJECTS);
    const cols = await columns(relation);
    expect(cols).toContain("geometry_lod2_2");
    expect(cols).not.toContain("geometry_lod1_2");
    expect(cols).toContain("status");
    expect(cols).not.toContain("b3_volume_lod22");

    const [meta] = await engine.query(
      `SELECT reference_system.code AS code FROM cityjson_metadata('${out("subset.city.json")}')`,
    );
    expect(meta!.code).toBe("7415");
  });

  it("CityJSON as a source: inspect and convert to CityJSONSeq", async () => {
    // subset.city.json was written by the previous case.
    const cj = await inspect(engine, {
      kind: "file",
      format: "cityjson",
      path: out("subset.city.json"),
    });
    expect(cj.schema.lods).toEqual(["2.2"]);
    expect(cj.schema.attributes.map((a) => a.name)).toEqual(["status"]);
    expect(cj.crs).toEqual({ authority: "EPSG", code: "7415" });

    await convert(engine, {
      info: cj,
      target: "cityjsonseq",
      selection: { lods: ["2.2"], attributes: ["status"] },
      output: out("from-cj.city.jsonl"),
    });
    expect(
      await count(`SELECT count(*) FROM read_cityjsonseq('${out("from-cj.city.jsonl")}')`),
    ).toBe(OBJECTS);
  });

  it("CityJSONSeq → FlatCityBuf → CityJSONSeq round-trips every object", async () => {
    await convert(engine, {
      info: seq,
      target: "flatcitybuf",
      selection: { lods: seq.schema.lods, attributes: seq.schema.attributes.map((a) => a.name) },
      output: out("all.fcb"),
    });
    expect(await count(`SELECT count(*) FROM read_flatcitybuf('${out("all.fcb")}')`)).toBe(OBJECTS);

    const fcb = await inspect(engine, {
      kind: "file",
      format: "flatcitybuf",
      path: out("all.fcb"),
    });
    expect(fcb.schema.lods).toEqual(seq.schema.lods);
    await convert(engine, {
      info: fcb,
      target: "cityjsonseq",
      selection: { lods: ["1.2"], attributes: [] },
      output: out("back.city.jsonl"),
    });
    expect(await count(`SELECT count(*) FROM read_cityjsonseq('${out("back.city.jsonl")}')`)).toBe(
      OBJECTS,
    );
  });
});

describe("CityParquet packages", () => {
  let seq: SourceInfo;
  beforeAll(async () => {
    seq = await inspect(engine, { kind: "file", format: "cityjsonseq", path: FIXTURE });
  });

  it("file → package writes module files and metadata.json with the chosen columns", async () => {
    const files = await convert(engine, {
      info: seq,
      target: "cityparquet",
      selection: { lods: ["2.2"], attributes: ["status"] },
      output: out("pkg"),
    });
    expect(files.map((f) => path.basename(f)).sort()).toEqual([
      "building.parquet",
      "metadata.json",
    ]);
    expect(readdirSync(out("pkg")).sort()).toEqual(["building.parquet", "metadata.json"]);

    const relation = `read_parquet('${out("pkg/building.parquet")}')`;
    expect(await count(`SELECT count(*) FROM ${relation}`)).toBe(OBJECTS);
    const cols = await columns(relation);
    expect(cols).toContain("geometry_lod2_2");
    expect(cols).not.toContain("geometry_lod0_0");
    expect(cols).toContain("status");
    expect(cols).not.toContain("b3_volume_lod22");
  });

  it("inspects a package: tables, LoDs, attributes and footer CRS", async () => {
    const info = await inspect(engine, { kind: "package", dir: out("pkg") });
    expect(info.tables).toEqual(["building"]);
    expect(info.schema.lods).toEqual(["2.2"]);
    expect(info.schema.attributes.map((a) => a.name)).toEqual(["status"]);
    expect(info.crs).toEqual({ authority: "EPSG", code: "7415" });
  });

  it("package → CityJSONSeq carries rows and CRS", async () => {
    const info = await inspect(engine, { kind: "package", dir: out("pkg") });
    await convert(engine, {
      info,
      target: "cityjsonseq",
      selection: { lods: ["2.2"], attributes: [] },
      output: out("from-pkg.city.jsonl"),
    });
    const relation = `read_cityjsonseq('${out("from-pkg.city.jsonl")}')`;
    expect(await count(`SELECT count(*) FROM ${relation}`)).toBe(OBJECTS);
    expect(await columns(relation)).not.toContain("status");
    const [meta] = await engine.query(
      `SELECT reference_system.code AS code FROM cityjsonseq_metadata('${out("from-pkg.city.jsonl")}')`,
    );
    expect(meta!.code).toBe("7415");
  });

  it("package → package keeps the CRS and can be inspected again", async () => {
    const info = await inspect(engine, { kind: "package", dir: out("pkg") });
    await convert(engine, {
      info,
      target: "cityparquet",
      selection: { lods: ["2.2"], attributes: [] },
      output: out("pkg2"),
    });
    const again = await inspect(engine, { kind: "package", dir: out("pkg2") });
    expect(again.crs).toEqual({ authority: "EPSG", code: "7415" });
    expect(again.schema.attributes).toEqual([]);
    // The source package is untouched by the conversion.
    const source = await inspect(engine, { kind: "package", dir: out("pkg") });
    expect(source.schema.attributes.map((a) => a.name)).toEqual(["status"]);
  });
});

// The community cityjson build has no read_obj yet; these run once it does (or against
// a local build), and skip rather than fail until then. The browser smoke test covers
// OBJ against the vendored build meanwhile.
describe("OBJ", () => {
  const CUBE = path.resolve(import.meta.dirname, "../fixtures/cube.obj");
  let available = false;

  beforeAll(async () => {
    available =
      (await count(`SELECT count(*) FROM duckdb_functions() WHERE function_name = 'read_obj'`)) > 0;
  });

  it("OBJ → CityJSONSeq carries the caller's CRS", async (ctx) => {
    if (!available) ctx.skip();
    const obj = await inspect(engine, {
      kind: "file",
      format: "obj",
      path: CUBE,
      options: { lod: "2.2", crs: { authority: "EPSG", code: "7415" } },
    });
    expect(obj.schema.lods).toEqual(["2.2"]);
    await convert(engine, {
      info: obj,
      target: "cityjsonseq",
      selection: { lods: ["2.2"], attributes: [] },
      output: out("cube.city.jsonl"),
    });
    expect(await count(`SELECT count(*) FROM read_cityjsonseq('${out("cube.city.jsonl")}')`)).toBe(
      2,
    );
  });

  it("CityJSONSeq → OBJ writes the .obj and .mtl into their own directory", async (ctx) => {
    if (!available) ctx.skip();
    const seq = await inspect(engine, { kind: "file", format: "cityjsonseq", path: FIXTURE });
    mkdirSync(out("obj")); // a native file system, unlike DuckDB-Wasm's, needs the directory
    const files = await convert(engine, {
      info: seq,
      target: "obj",
      selection: { lods: ["2.2"], attributes: [] },
      output: out("obj/delft.obj"),
    });
    expect(files.map((f) => path.basename(f))).toEqual(["delft.mtl", "delft.obj"]);
    // Objects with no LoD 2.2 geometry (3DBAG's parent Buildings) are not written.
    const withLod22 = await count(
      `SELECT count(*) FROM read_cityjsonseq('${FIXTURE}') WHERE geometry_lod2_2 IS NOT NULL`,
    );
    expect(
      await count(`SELECT count(*) FROM read_obj('${out("obj/delft.obj")}', lod := '2.2')`),
    ).toBe(withLod22);
  });
});
