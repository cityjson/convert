// The formats the app converts between, and how the cityjson extension reads and
// writes each one. Only formats the extension supports belong here.

export type FileFormatId = "cityjson" | "cityjsonseq" | "flatcitybuf" | "obj";
export type FormatId = FileFormatId | "cityparquet";

export interface FileFormat {
  id: FileFormatId;
  kind: "file";
  label: string;
  /** Output file extension. */
  extension: string;
  /** Table function that reads the format, e.g. `read_cityjsonseq`. */
  reader: string;
  /** Table function returning dataset metadata (CRS, version, counts). */
  metadata: string;
  /** `FORMAT` name for `COPY … TO`. */
  copyFormat: string;
  /**
   * Pragma that inserts this format into a CityParquet package schema, or null when the
   * extension has none (OBJ: every object is one class, so it is loaded directly).
   */
  insertPragma: string | null;
  /** Writing it can produce several files (OBJ: the .obj, its .mtl and texture images). */
  multiFile: boolean;
  /**
   * The format carries no LoD or CRS of its own: the caller supplies a LoD to read it
   * with and, optionally, a CRS (OBJ).
   */
  needsReadOptions: boolean;
}

export interface PackageFormat {
  id: "cityparquet";
  kind: "package";
  label: string;
  /** A package is a directory, downloaded as a zip. */
  extension: string;
}

export type Format = FileFormat | PackageFormat;

export const FORMATS = {
  cityjson: {
    id: "cityjson",
    kind: "file",
    label: "CityJSON",
    extension: ".city.json",
    reader: "read_cityjson",
    metadata: "cityjson_metadata",
    copyFormat: "cityjson",
    insertPragma: "insert_cityjson",
    multiFile: false,
    needsReadOptions: false,
  },
  cityjsonseq: {
    id: "cityjsonseq",
    kind: "file",
    label: "CityJSONSeq",
    extension: ".city.jsonl",
    reader: "read_cityjsonseq",
    metadata: "cityjsonseq_metadata",
    copyFormat: "cityjsonseq",
    insertPragma: "insert_cityjsonseq",
    multiFile: false,
    needsReadOptions: false,
  },
  flatcitybuf: {
    id: "flatcitybuf",
    kind: "file",
    label: "FlatCityBuf",
    extension: ".fcb",
    reader: "read_flatcitybuf",
    metadata: "flatcitybuf_metadata",
    copyFormat: "flatcitybuf",
    insertPragma: "insert_flatcitybuf",
    multiFile: false,
    needsReadOptions: false,
  },
  obj: {
    id: "obj",
    kind: "file",
    label: "OBJ",
    extension: ".obj",
    reader: "read_obj",
    metadata: "obj_metadata",
    copyFormat: "obj",
    insertPragma: null,
    multiFile: true,
    needsReadOptions: true,
  },
  cityparquet: {
    id: "cityparquet",
    kind: "package",
    label: "CityParquet",
    extension: ".zip",
  },
} as const satisfies Record<FormatId, Format>;

export const FORMAT_IDS = Object.keys(FORMATS) as FormatId[];

export function isFileFormat(id: FormatId): id is FileFormatId {
  return FORMATS[id].kind === "file";
}
