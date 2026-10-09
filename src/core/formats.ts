// The formats the app converts between, and how the cityjson extension reads and
// writes each one. Only formats the extension supports belong here.

export type FileFormatId = "cityjson" | "cityjsonseq" | "flatcitybuf";
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
  /** Pragma that inserts this format into a CityParquet package schema. */
  insertPragma: string;
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
