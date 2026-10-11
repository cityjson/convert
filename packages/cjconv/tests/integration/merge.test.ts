// Several inputs of one dataset combined into one output, against the native extension.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { convert, inspect, type FileSource } from "@cityjson/cjconv-core";
import { createNodeEngine, type NodeEngine } from "../../src/engine";

const FIXTURE = path.resolve(import.meta.dirname, "../../../../fixtures/delft_subset.city.jsonl");
const OBJECTS = 40;

let engine: NodeEngine;
let dir: string;
const out = (name: string) => path.join(dir, name);
const seq = (p: string): FileSource => ({ kind: "file", format: "cityjsonseq", path: p });

async function count(sql: string): Promise<number> {
  const [row] = await engine.query(sql);
  return Number(Object.values(row!)[0]);
}

beforeAll(async () => {
  engine = await createNodeEngine();
  dir = mkdtempSync(path.join(tmpdir(), "cjconv-merge-"));
  // Two tiles of the same dataset: the first 10 features, and the other 10. Written by
  // the extension from the 3DBAG fixture, so ids, CRS and types are the dataset's own.
  const read = `read_cityjsonseq('${FIXTURE}')`;
  const firstTen = `(SELECT DISTINCT feature_id FROM ${read} ORDER BY feature_id LIMIT 10)`;
  await engine.exec(
    `COPY (SELECT * FROM ${read} WHERE feature_id IN ${firstTen}) TO '${out("a.city.jsonl")}' (FORMAT cityjsonseq, metadata_from '${FIXTURE}')`,
  );
  await engine.exec(
    `COPY (SELECT * FROM ${read} WHERE feature_id NOT IN ${firstTen}) TO '${out("b.city.jsonl")}' (FORMAT cityjsonseq, metadata_from '${FIXTURE}')`,
  );
  // b without the `status` attribute: a tile may simply lack one.
  await engine.exec(
    `COPY (SELECT * EXCLUDE (status) FROM ${read} WHERE feature_id NOT IN ${firstTen}) TO '${out("b-nostatus.city.jsonl")}' (FORMAT cityjsonseq, metadata_from '${FIXTURE}')`,
  );
  // b in another CRS.
  await engine.exec(
    `COPY (SELECT * FROM ${read} WHERE feature_id NOT IN ${firstTen}) TO '${out("b-28992.city.jsonl")}' (FORMAT cityjsonseq, crs 'https://www.opengis.net/def/crs/EPSG/0/28992')`,
  );
  // b whose `status` is a number: the same column name with another type.
  await engine.exec(
    `COPY (SELECT * REPLACE (42 AS status) FROM ${read} WHERE feature_id NOT IN ${firstTen}) TO '${out("b-intstatus.city.jsonl")}' (FORMAT cityjsonseq, metadata_from '${FIXTURE}')`,
  );
});

afterAll(() => {
  engine?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("merging inputs", () => {
  it("inspects the combination: every LoD and attribute, the shared CRS, the summed count", async () => {
    const info = await inspect(engine, {
      kind: "merge",
      sources: [seq(out("a.city.jsonl")), seq(out("b.city.jsonl"))],
    });
    expect(info.objects).toBe(OBJECTS);
    expect(info.crs).toEqual({ authority: "EPSG", code: "7415" });
    expect(info.schema.lods).toEqual(["0.0", "1.2", "1.3", "2.2"]);
    expect(info.schema.attributes.map((a) => a.name)).toContain("status");
  });

  it("writes one file holding every object", async () => {
    const info = await inspect(engine, {
      kind: "merge",
      sources: [seq(out("a.city.jsonl")), seq(out("b.city.jsonl"))],
    });
    await convert(engine, {
      info,
      target: "flatcitybuf",
      selection: { lods: ["2.2"], attributes: ["status"] },
      output: out("ab.fcb"),
    });
    expect(await count(`SELECT count(*) FROM read_flatcitybuf('${out("ab.fcb")}')`)).toBe(OBJECTS);
    const [meta] = await engine.query(
      `SELECT reference_system.code AS code FROM flatcitybuf_metadata('${out("ab.fcb")}')`,
    );
    expect(meta!.code).toBe("7415");
  });

  it("writes one CityParquet package holding every object", async () => {
    const info = await inspect(engine, {
      kind: "merge",
      sources: [seq(out("a.city.jsonl")), seq(out("b.city.jsonl"))],
    });
    await convert(engine, {
      info,
      target: "cityparquet",
      selection: { lods: info.schema.lods, attributes: [] },
      output: out("ab_pkg"),
    });
    expect(readdirSync(out("ab_pkg")).sort()).toEqual(["building.parquet", "metadata.json"]);
    expect(
      await count(`SELECT count(*) FROM read_parquet('${out("ab_pkg/building.parquet")}')`),
    ).toBe(OBJECTS);
  });

  it("fills an attribute one input lacks with NULL", async () => {
    const info = await inspect(engine, {
      kind: "merge",
      sources: [seq(out("a.city.jsonl")), seq(out("b-nostatus.city.jsonl"))],
    });
    await convert(engine, {
      info,
      target: "cityjsonseq",
      selection: { lods: ["2.2"], attributes: ["status"] },
      output: out("ab-partial.city.jsonl"),
    });
    const relation = `read_cityjsonseq('${out("ab-partial.city.jsonl")}')`;
    expect(await count(`SELECT count(*) FROM ${relation}`)).toBe(OBJECTS);
    expect(
      await count(`SELECT count(*) FROM ${relation} WHERE status IS NOT NULL`),
    ).toBeGreaterThan(0);
    expect(await count(`SELECT count(*) FROM ${relation} WHERE status IS NULL`)).toBeGreaterThan(0);
  });
});

describe("merge refusals", () => {
  it("refuses an id that appears in more than one input, naming it", async () => {
    const info = await inspect(engine, {
      kind: "merge",
      sources: [seq(out("a.city.jsonl")), seq(out("a.city.jsonl"))],
    });
    await expect(
      convert(engine, {
        info,
        target: "flatcitybuf",
        selection: { lods: ["2.2"], attributes: [] },
        output: out("dup.fcb"),
      }),
    ).rejects.toThrow(/duplicate id.*NL\.IMBAG\.Pand\./i);
  });

  it("refuses inputs in different CRSs", async () => {
    await expect(
      inspect(engine, {
        kind: "merge",
        sources: [seq(out("a.city.jsonl")), seq(out("b-28992.city.jsonl"))],
      }),
    ).rejects.toThrow(/CRS.*7415.*28992/);
  });

  it("refuses a column whose type differs between inputs, naming it", async () => {
    await expect(
      inspect(engine, {
        kind: "merge",
        sources: [seq(out("a.city.jsonl")), seq(out("b-intstatus.city.jsonl"))],
      }),
    ).rejects.toThrow(/status/);
  });
});
