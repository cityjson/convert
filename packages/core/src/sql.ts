// SQL text builders. Pure string functions: no execution happens here.
import { crsToAuthCode, type Crs } from "./crs";
import { FORMATS, type FileFormatId } from "./formats";

/** Reader parameters for formats that do not carry them (OBJ). */
export interface ReadOptions {
  /** The LoD the geometry is read as, e.g. "2.2". Required by read_obj. */
  lod?: string;
  /** The CRS the coordinates are in. */
  crs?: Crs;
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The table-function call that reads a file, e.g. `read_cityjson('a.city.json')`. */
export function readSql(format: FileFormatId, path: string, options: ReadOptions = {}): string {
  const args = [quoteLiteral(path)];
  if (options.lod) args.push(`lod := ${quoteLiteral(options.lod)}`);
  return `${FORMATS[format].reader}(${args.join(", ")})`;
}

export function describeSql(relation: string): string {
  return `DESCRIBE SELECT * FROM ${relation}`;
}

/** The metadata table-function call, e.g. `obj_metadata('a.obj', crs := 'EPSG:7415')`. */
export function metadataCall(
  format: FileFormatId,
  path: string,
  options: ReadOptions = {},
): string {
  const args = [quoteLiteral(path)];
  // Only obj_metadata takes a CRS: the other formats state their own.
  if (options.crs && format === "obj")
    args.push(`crs := ${quoteLiteral(crsToAuthCode(options.crs))}`);
  return `${FORMATS[format].metadata}(${args.join(", ")})`;
}

export function metadataSql(format: FileFormatId, path: string, options: ReadOptions = {}): string {
  return `SELECT * FROM ${metadataCall(format, path, options)}`;
}

export function selectSql(columns: string[], from: string): string {
  return `SELECT ${columns.map(quoteIdent).join(", ")} FROM ${from}`;
}

type CopyInput =
  | { columns: string[]; from: string; relation?: never }
  | { relation: string; columns?: never; from?: never };

export type CopyOptions = {
  to: string;
  format: FileFormatId;
  /** COPY options; string values are quoted as literals. */
  options: Record<string, string>;
} & CopyInput;

export function copySql(spec: CopyOptions): string {
  const relation = spec.relation ?? selectSql(spec.columns, spec.from);
  const options = [
    `FORMAT ${FORMATS[spec.format].copyFormat}`,
    ...Object.entries(spec.options).map(([k, v]) => `${k} ${quoteLiteral(v)}`),
  ];
  return `COPY (${relation}) TO ${quoteLiteral(spec.to)} (${options.join(", ")})`;
}
