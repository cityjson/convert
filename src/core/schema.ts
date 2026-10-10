// Classifies the columns the cityjson extension produces into structural columns,
// LoD groups and attributes, and decides which to keep for a conversion.

export interface Column {
  name: string;
  type: string;
}

export interface SourceSchema {
  /** All columns, in source order. */
  columns: Column[];
  /** LoDs present in the data, e.g. ["1.2", "2.2"], sorted. */
  lods: string[];
  /** CityJSON attribute columns, in source order. */
  attributes: Column[];
}

export interface Selection {
  lods: string[];
  attributes: string[];
}

/**
 * Columns that carry CityJSON structure rather than attributes. A conversion always
 * keeps them: dropping them would break hierarchy, geometry or round-tripping.
 */
const STRUCTURAL = new Set([
  "id",
  "feature_id",
  "object_type",
  "parents",
  "children",
  "children_roles",
  "address",
  "template", // the community v0.4.0 build's name for implicit_geometry
  "implicit_geometry",
  "other",
  "bbox",
  "geometry",
  "geometry_properties",
  "material",
  "texture",
]);

const LOD_COLUMN = /^(?:geometry|geometry_properties|material|texture)_lod(\d+)_(\d+)$/;

function lodOf(name: string): string | undefined {
  const m = LOD_COLUMN.exec(name);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

export function analyzeColumns(columns: Column[]): SourceSchema {
  const lods = new Set<string>();
  const attributes: Column[] = [];
  for (const col of columns) {
    const lod = lodOf(col.name);
    if (lod) lods.add(lod);
    else if (!STRUCTURAL.has(col.name)) attributes.push(col);
  }
  return {
    columns,
    lods: [...lods].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    attributes,
  };
}

/** The four columns of one LoD group, e.g. "2.2" → geometry_lod2_2, …. */
export function lodColumns(lod: string): string[] {
  const suffix = `lod${lod.replace(".", "_")}`;
  return [
    `geometry_${suffix}`,
    `geometry_properties_${suffix}`,
    `material_${suffix}`,
    `texture_${suffix}`,
  ];
}

/** Column names to keep, in source order: all structural columns plus the selection. */
export function selectColumns(schema: SourceSchema, selection: Selection): string[] {
  const lods = new Set(selection.lods);
  const attributes = new Set(selection.attributes);
  return schema.columns
    .map((c) => c.name)
    .filter((name) => {
      const lod = lodOf(name);
      if (lod) return lods.has(lod);
      return STRUCTURAL.has(name) || attributes.has(name);
    });
}
