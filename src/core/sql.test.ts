import { describe, expect, it } from "vite-plus/test";
import { copySql, describeSql, metadataSql, quoteIdent, quoteLiteral, readSql } from "./sql";

describe("quoting", () => {
  it("quotes identifiers, doubling embedded quotes", () => {
    expect(quoteIdent("status")).toBe('"status"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it("quotes string literals, doubling embedded quotes", () => {
    expect(quoteLiteral("delft.city.json")).toBe("'delft.city.json'");
    expect(quoteLiteral("o'neil.fcb")).toBe("'o''neil.fcb'");
  });
});

describe("readSql", () => {
  it.each([
    ["cityjson", "read_cityjson('in.city.json')"],
    ["cityjsonseq", "read_cityjsonseq('in.city.json')"],
    ["flatcitybuf", "read_flatcitybuf('in.city.json')"],
  ] as const)("reads %s with its table function", (format, expected) => {
    expect(readSql(format, "in.city.json")).toBe(expected);
  });
});

describe("describeSql / metadataSql", () => {
  it("describes a relation", () => {
    expect(describeSql("read_cityjson('a')")).toBe("DESCRIBE SELECT * FROM read_cityjson('a')");
  });

  it("reads format metadata", () => {
    expect(metadataSql("flatcitybuf", "a.fcb")).toBe("SELECT * FROM flatcitybuf_metadata('a.fcb')");
  });
});

describe("copySql", () => {
  it("copies selected columns into a file format with options", () => {
    expect(
      copySql({
        columns: ["id", "status"],
        from: "read_cityjsonseq('in.city.jsonl')",
        to: "out.city.json",
        format: "cityjson",
        options: { metadata_from: "in.city.jsonl" },
      }),
    ).toBe(
      `COPY (SELECT "id", "status" FROM read_cityjsonseq('in.city.jsonl')) ` +
        `TO 'out.city.json' (FORMAT cityjson, metadata_from 'in.city.jsonl')`,
    );
  });

  it("accepts a raw relation for multi-table sources", () => {
    expect(
      copySql({
        relation: `SELECT "id" FROM "src"."building"`,
        to: "o.fcb",
        format: "flatcitybuf",
        options: {},
      }),
    ).toBe(`COPY (SELECT "id" FROM "src"."building") TO 'o.fcb' (FORMAT flatcitybuf)`);
  });
});
