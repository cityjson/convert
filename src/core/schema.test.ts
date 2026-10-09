import { describe, expect, it } from "vite-plus/test";
import { analyzeColumns, lodColumns, selectColumns, type Column } from "./schema";

const col = (name: string, type = "VARCHAR"): Column => ({ name, type });

// The column order read_cityjsonseq produces for the Delft data, trimmed.
const DELFT: Column[] = [
  col("id"),
  col("feature_id"),
  col("object_type"),
  col("parents", "VARCHAR[]"),
  col("children", "VARCHAR[]"),
  col("children_roles", "VARCHAR[]"),
  col("address", "STRUCT(street VARCHAR)[]"),
  col("bbox", "STRUCT(xmin DOUBLE)"),
  col("geometry_lod0_0", "BLOB"),
  col("geometry_properties_lod0_0", "STRUCT(type VARCHAR)"),
  col("material_lod0_0"),
  col("texture_lod0_0"),
  col("geometry_lod2_2", "BLOB"),
  col("geometry_properties_lod2_2", "STRUCT(type VARCHAR)"),
  col("material_lod2_2"),
  col("texture_lod2_2"),
  col("geometry_lod1_2", "BLOB"),
  col("geometry_properties_lod1_2", "STRUCT(type VARCHAR)"),
  col("material_lod1_2"),
  col("texture_lod1_2"),
  col("template", "STRUCT(id BIGINT)"),
  col("other"),
  col("b3_volume_lod22", "DOUBLE"),
  col("status"),
];

describe("analyzeColumns", () => {
  const schema = analyzeColumns(DELFT);

  it("lists LoDs present in the data, sorted", () => {
    expect(schema.lods).toEqual(["0.0", "1.2", "2.2"]);
  });

  it("lists attribute columns only, in source order", () => {
    expect(schema.attributes.map((c) => c.name)).toEqual(["b3_volume_lod22", "status"]);
  });

  it("does not mistake an attribute containing 'lod' for a LoD group", () => {
    expect(schema.attributes.map((c) => c.name)).toContain("b3_volume_lod22");
    expect(schema.lods).not.toContain("22");
  });

  it("treats LoD-less geometry columns as structural, not attributes", () => {
    const s = analyzeColumns([
      col("id"),
      col("geometry", "BLOB"),
      col("geometry_properties"),
      col("x"),
    ]);
    expect(s.attributes.map((c) => c.name)).toEqual(["x"]);
    expect(s.lods).toEqual([]);
  });
});

describe("lodColumns", () => {
  it("returns the four columns of a LoD group", () => {
    expect(lodColumns("2.2")).toEqual([
      "geometry_lod2_2",
      "geometry_properties_lod2_2",
      "material_lod2_2",
      "texture_lod2_2",
    ]);
  });
});

describe("selectColumns", () => {
  const schema = analyzeColumns(DELFT);

  it("keeps every structural column, the chosen LoDs and the chosen attributes, in source order", () => {
    expect(selectColumns(schema, { lods: ["2.2"], attributes: ["status"] })).toEqual([
      "id",
      "feature_id",
      "object_type",
      "parents",
      "children",
      "children_roles",
      "address",
      "bbox",
      "geometry_lod2_2",
      "geometry_properties_lod2_2",
      "material_lod2_2",
      "texture_lod2_2",
      "template",
      "other",
      "status",
    ]);
  });

  it("can drop every LoD and attribute but never structural columns", () => {
    const cols = selectColumns(schema, { lods: [], attributes: [] });
    expect(cols).toEqual([
      "id",
      "feature_id",
      "object_type",
      "parents",
      "children",
      "children_roles",
      "address",
      "bbox",
      "template",
      "other",
    ]);
  });

  it("ignores selections that are not in the schema", () => {
    const cols = selectColumns(schema, { lods: ["3.0"], attributes: ["nope"] });
    expect(cols).not.toContain("geometry_lod3_0");
    expect(cols).not.toContain("nope");
  });
});
