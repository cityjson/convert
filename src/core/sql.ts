// SQL text builders. Pure string functions: no execution happens here.
import { FORMATS, type FileFormatId } from "./formats";

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The table-function call that reads a file, e.g. `read_cityjson('a.city.json')`. */
export function readSql(format: FileFormatId, path: string): string {
  return `${FORMATS[format].reader}(${quoteLiteral(path)})`;
}

export function describeSql(relation: string): string {
  return `DESCRIBE SELECT * FROM ${relation}`;
}

export function metadataSql(format: FileFormatId, path: string): string {
  return `SELECT * FROM ${FORMATS[format].metadata}(${quoteLiteral(path)})`;
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
