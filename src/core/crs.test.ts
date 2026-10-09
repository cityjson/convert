import { describe, expect, it } from "vite-plus/test";
import { crsFromProjjson, crsFromReferenceSystem, crsToAuthCode, crsToUri } from "./crs";

describe("crsFromReferenceSystem", () => {
  it("reads the struct that *_metadata() returns", () => {
    expect(
      crsFromReferenceSystem({
        base_url: "https://www.opengis.net/def/crs/",
        authority: "EPSG",
        version: "0",
        code: "7415",
      }),
    ).toEqual({ authority: "EPSG", code: "7415" });
  });

  it("returns undefined when there is no CRS", () => {
    expect(crsFromReferenceSystem(null)).toBeUndefined();
    expect(crsFromReferenceSystem({ authority: null, code: null })).toBeUndefined();
  });
});

describe("crsFromProjjson", () => {
  it("reads the top-level id of a CityParquet footer CRS", () => {
    const projjson = JSON.stringify({
      type: "CompoundCRS",
      name: "Amersfoort / RD New + NAP height",
      id: { authority: "EPSG", code: 7415 },
    });
    expect(crsFromProjjson(projjson)).toEqual({ authority: "EPSG", code: "7415" });
  });

  it("returns undefined for null, invalid JSON or a CRS without id", () => {
    expect(crsFromProjjson(null)).toBeUndefined();
    expect(crsFromProjjson("not json")).toBeUndefined();
    expect(crsFromProjjson('{"type":"GeographicCRS"}')).toBeUndefined();
  });
});

describe("formatting", () => {
  const crs = { authority: "EPSG", code: "7415" };

  it("formats the OGC URI that COPY's crs option takes", () => {
    expect(crsToUri(crs)).toBe("https://www.opengis.net/def/crs/EPSG/0/7415");
  });

  it("formats the AUTH:CODE that cityparquet_write takes", () => {
    expect(crsToAuthCode(crs)).toBe("EPSG:7415");
  });
});
