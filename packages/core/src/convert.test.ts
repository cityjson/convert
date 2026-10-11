import { describe, expect, it } from "vite-plus/test";
import { convert, type SourceInfo } from "./convert";
import type { Engine, Row } from "./engine";
import { analyzeColumns } from "./schema";

/** An Engine that answers glob() from a fake directory listing and records the SQL. */
function fakeEngine(listings: string[][]): Engine & { sql: string[] } {
  const sql: string[] = [];
  let globs = 0;
  return {
    sql,
    async query(text: string): Promise<Row[]> {
      sql.push(text);
      if (text.includes("FROM glob(")) return (listings[globs++] ?? []).map((file) => ({ file }));
      return [];
    },
    async exec(text: string): Promise<void> {
      sql.push(text);
    },
  };
}

const info: SourceInfo = {
  source: { kind: "file", format: "cityjsonseq", path: "in.city.jsonl" },
  schema: analyzeColumns([
    { name: "id", type: "VARCHAR" },
    { name: "geometry_lod2_2", type: "BLOB" },
  ]),
  tables: [],
};

describe("convert to OBJ", () => {
  it("returns the .obj, its .mtl and new files, never what was already in the directory", async () => {
    const engine = fakeEngine([
      ["work/notes.txt", "work/old.png"],
      ["work/notes.txt", "work/old.png", "work/delft.obj", "work/delft.mtl", "work/brick.png"],
    ]);
    const files = await convert(engine, {
      info,
      target: "obj",
      selection: { lods: ["2.2"], attributes: [] },
      output: "work/delft.obj",
    });
    expect(files.sort()).toEqual(["work/brick.png", "work/delft.mtl", "work/delft.obj"]);
  });

  it("lists the directory before writing, so a pre-existing .mtl is still reported", async () => {
    const engine = fakeEngine([["work/delft.mtl"], ["work/delft.mtl", "work/delft.obj"]]);
    const files = await convert(engine, {
      info,
      target: "obj",
      selection: { lods: ["2.2"], attributes: [] },
      output: "work/delft.obj",
    });
    expect(files.sort()).toEqual(["work/delft.mtl", "work/delft.obj"]);
    const copyAt = engine.sql.findIndex((s) => s.startsWith("COPY"));
    const firstGlob = engine.sql.findIndex((s) => s.includes("FROM glob("));
    expect(firstGlob).toBeLessThan(copyAt);
  });

  it("writes into the current directory when the output has no directory part", async () => {
    const engine = fakeEngine([[], ["delft.obj", "delft.mtl"]]);
    const files = await convert(engine, {
      info,
      target: "obj",
      selection: { lods: ["2.2"], attributes: [] },
      output: "delft.obj",
    });
    expect(files.sort()).toEqual(["delft.mtl", "delft.obj"]);
  });
});
