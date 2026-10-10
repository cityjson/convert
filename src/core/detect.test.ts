import { describe, expect, it } from "vite-plus/test";
import { baseName, detectFormat, isObjSidecar, isPackagePath, packageTableName } from "./detect";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("detectFormat", () => {
  it.each([
    ["delft.city.json", "cityjson"],
    ["DELFT.CITY.JSON", "cityjson"],
    ["delft.json", "cityjson"],
    ["delft.city.jsonl", "cityjsonseq"],
    ["delft.jsonl", "cityjsonseq"],
    ["delft.fcb", "flatcitybuf"],
    ["Cube.OBJ", "obj"],
    ["delft.zip", "cityparquet"],
    ["building.parquet", "cityparquet"],
    ["https://example.com/data/delft.city.jsonl?token=x", "cityjsonseq"],
  ] as const)("detects %s as %s from its name", (name, format) => {
    expect(detectFormat(name)).toBe(format);
  });

  it("returns undefined for unknown names", () => {
    expect(detectFormat("delft.gml")).toBeUndefined();
  });

  it("prefers content over the name", () => {
    const seq = bytes('{"type":"CityJSON","CityObjects":{}}\n{"type":"CityJSONFeature","id":"a"}');
    expect(detectFormat("delft.json", seq)).toBe("cityjsonseq");
  });

  it("sniffs CityJSON", () => {
    expect(detectFormat("data", bytes('{"type":"CityJSON","version":"2.0"}'))).toBe("cityjson");
  });

  it("sniffs CityJSON with whitespace and a BOM", () => {
    expect(detectFormat("data", bytes('﻿  {\n  "type": "CityJSON"\n}'))).toBe("cityjson");
  });

  it("sniffs FlatCityBuf magic bytes", () => {
    const fcb = new Uint8Array([0x66, 0x63, 0x62, 0x01, 0x66, 0x63, 0x62, 0x00]);
    expect(detectFormat("data", fcb)).toBe("flatcitybuf");
  });

  it("sniffs a zip archive as a CityParquet package", () => {
    expect(detectFormat("data", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("cityparquet");
  });

  it("falls back to the name when content is not recognised", () => {
    expect(detectFormat("delft.fcb", bytes("garbage"))).toBe("flatcitybuf");
  });
});

describe("OBJ sidecars", () => {
  it("recognises the files that travel with an OBJ", () => {
    expect(isObjSidecar("model/cube.mtl")).toBe(true);
    expect(isObjSidecar("model/brick.PNG")).toBe(true);
    expect(isObjSidecar("model/brick.jpg")).toBe(true);
    expect(isObjSidecar("model/readme.txt")).toBe(false);
  });
});

describe("package paths", () => {
  it("recognises module parquet files and metadata.json", () => {
    expect(isPackagePath("pkg/building.parquet")).toBe(true);
    expect(isPackagePath("pkg/metadata.json")).toBe(true);
    expect(isPackagePath("pkg/readme.txt")).toBe(false);
  });

  it("derives the table name from a module file", () => {
    expect(packageTableName("some/dir/water_body.parquet")).toBe("water_body");
    expect(packageTableName("metadata.json")).toBeUndefined();
  });
});

describe("baseName", () => {
  it.each([
    ["delft.city.json", "delft"],
    ["delft.city.jsonl", "delft"],
    ["Delft Tile.FCB", "Delft Tile"],
    ["pkg.zip", "pkg"],
    ["cube.obj", "cube"],
    ["https://x.org/data/delft.city.jsonl?sig=1", "delft"],
    ["noext", "noext"],
    ["", "citymodel"],
  ])("%s → %s", (name, expected) => {
    expect(baseName(name)).toBe(expected);
  });
});
