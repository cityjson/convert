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

describe("merging with hostile column types", () => {
  // A crafted file can make a reader infer a nested type whose field names come from the
  // file: such a type string must never be pasted into SQL.
  const HOSTILE = `STRUCT("x" INTEGER) ; COPY (SELECT 1) TO '/tmp/pwned' --`;

  function describingEngine(
    types: Record<string, string>,
    emptyIn: string[] = [],
  ): Engine & { sql: string[] } {
    const sql: string[] = [];
    return {
      sql,
      async query(text: string): Promise<Row[]> {
        sql.push(text);
        if (text.startsWith("DESCRIBE")) {
          const path = Object.keys(types).find((p) => text.includes(p))!;
          return [
            { column_name: "id", column_type: "VARCHAR" },
            { column_name: "attr", column_type: types[path] },
          ];
        }
        if (text.includes("count(")) return [{ n: emptyIn.some((p) => text.includes(p)) ? 0 : 1 }];
        return [{}];
      },
      async exec(text: string): Promise<void> {
        sql.push(text);
      },
    };
  }

  it("refuses the conflict instead of casting to a type it did not choose", async () => {
    const engine = describingEngine({ "a.city.jsonl": "VARCHAR", "b.city.jsonl": HOSTILE });
    const { inspect } = await import("./convert");
    await expect(
      inspect(engine, {
        kind: "merge",
        sources: [
          { kind: "file", format: "cityjsonseq", path: "a.city.jsonl" },
          { kind: "file", format: "cityjsonseq", path: "b.city.jsonl" },
        ],
      }),
    ).rejects.toThrow(/do not share a schema/);
    expect(engine.sql.some((s) => s.includes("pwned"))).toBe(false);
  });

  it("never adopts a hostile type, even when the other input's column is empty", async () => {
    const engine = describingEngine({ "a.city.jsonl": "VARCHAR", "b.city.jsonl": HOSTILE }, [
      "a.city.jsonl",
    ]);
    const { inspect } = await import("./convert");
    await expect(
      inspect(engine, {
        kind: "merge",
        sources: [
          { kind: "file", format: "cityjsonseq", path: "a.city.jsonl" },
          { kind: "file", format: "cityjsonseq", path: "b.city.jsonl" },
        ],
      }),
    ).rejects.toThrow(/do not share a schema/);
    expect(engine.sql.some((s) => s.includes("pwned"))).toBe(false);
  });
});
