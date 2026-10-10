// Inspects a source and converts it, by sending SQL to an Engine. Every read and
// write is done by the cityjson extension; this module only decides what to run.
import { crsFromProjjson, crsFromReferenceSystem, crsToAuthCode, crsToUri, type Crs } from "./crs";
import type { Engine } from "./engine";
import { FORMATS, isFileFormat, type FileFormatId, type FormatId } from "./formats";
import {
  analyzeColumns,
  selectColumns,
  type Column,
  type Selection,
  type SourceSchema,
} from "./schema";
import {
  copySql,
  describeSql,
  metadataCall,
  metadataSql,
  quoteIdent,
  quoteLiteral,
  readSql,
  selectSql,
  type ReadOptions,
} from "./sql";

export type Source =
  | {
      kind: "file";
      format: FileFormatId;
      path: string;
      /** For formats that carry no LoD or CRS of their own (OBJ). */
      options?: ReadOptions;
    }
  | { kind: "package"; dir: string };

export interface SourceInfo {
  source: Source;
  schema: SourceSchema;
  crs?: Crs;
  /** Object tables of a package source (e.g. ["building"]); empty for files. */
  tables: string[];
}

export interface ConvertRequest {
  info: SourceInfo;
  target: FormatId;
  selection: Selection;
  /**
   * Output file path, or output directory when the target is a package. A multi-file
   * target (OBJ) writes its sidecars beside the file, so give it a directory of its own.
   */
  output: string;
}

/** The CityGML-module object tables a CityParquet package may contain. */
const MODULE_TABLES = new Set([
  "building",
  "bridge",
  "tunnel",
  "construction",
  "transportation",
  "vegetation",
  "relief",
  "water_body",
  "land_use",
  "city_furniture",
  "generics",
]);

// Schemas the orchestrator owns. Each conversion recreates them from scratch.
const INSPECT_SCHEMA = "convert_inspect";
const WORK_SCHEMA = "convert_work";

async function describe(engine: Engine, relation: string): Promise<Column[]> {
  const rows = await engine.query(describeSql(relation));
  return rows.map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
}

const table = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`;

async function resetSchema(engine: Engine, schema: string): Promise<void> {
  await engine.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
}

/** Loads a package directory into `schema`, recovering its Parquet footers. */
async function readPackage(engine: Engine, dir: string, schema: string): Promise<string[]> {
  await resetSchema(engine, schema);
  await engine.exec(`PRAGMA cityparquet_read(${quoteLiteral(dir)}, ${quoteLiteral(schema)})`);
  const rows = await engine.query(
    `SELECT table_name FROM ${table(schema, "__cityparquet")} WHERE role = 'object' ORDER BY table_name`,
  );
  return rows.map((r) => String(r.table_name)).filter((t) => MODULE_TABLES.has(t));
}

async function packageCrs(engine: Engine, schema: string): Promise<Crs | undefined> {
  const rows = await engine.query(
    `SELECT cityparquet_city_field(city, 'crs') AS crs FROM ${table(schema, "__cityparquet")} ` +
      `WHERE role = 'object' AND city IS NOT NULL`,
  );
  for (const row of rows) {
    const crs = crsFromProjjson(row.crs as string | null);
    if (crs) return crs;
  }
  return undefined;
}

/** Union of the tables' columns, first occurrence wins, so the order stays stable. */
async function unionColumns(engine: Engine, schema: string, tables: string[]): Promise<Column[]> {
  const seen = new Map<string, Column>();
  for (const t of tables) {
    for (const col of await describe(engine, table(schema, t))) {
      if (!seen.has(col.name)) seen.set(col.name, col);
    }
  }
  return [...seen.values()];
}

export async function inspect(engine: Engine, source: Source): Promise<SourceInfo> {
  if (source.kind === "file") {
    const columns = await describe(engine, readSql(source.format, source.path, source.options));
    const [meta] = await engine.query(metadataSql(source.format, source.path, source.options));
    return {
      source,
      schema: analyzeColumns(columns),
      crs: crsFromReferenceSystem(
        meta?.reference_system as Parameters<typeof crsFromReferenceSystem>[0],
      ),
      tables: [],
    };
  }
  const tables = await readPackage(engine, source.dir, INSPECT_SCHEMA);
  const info: SourceInfo = {
    source,
    schema: analyzeColumns(await unionColumns(engine, INSPECT_SCHEMA, tables)),
    crs: await packageCrs(engine, INSPECT_SCHEMA),
    tables,
  };
  await resetSchema(engine, INSPECT_SCHEMA);
  return info;
}

/** Drops every column of the package's object tables that the selection does not keep. */
async function pruneTables(
  engine: Engine,
  schema: string,
  tables: string[],
  selection: Selection,
): Promise<void> {
  for (const t of tables) {
    const columns = await describe(engine, table(schema, t));
    const keep = new Set(selectColumns(analyzeColumns(columns), selection));
    for (const col of columns) {
      if (!keep.has(col.name)) {
        await engine.exec(`ALTER TABLE ${table(schema, t)} DROP COLUMN ${quoteIdent(col.name)}`);
      }
    }
  }
}

async function objectTables(engine: Engine, schema: string): Promise<string[]> {
  const rows = await engine.query(
    `SELECT table_name FROM duckdb_tables() WHERE schema_name = ${quoteLiteral(schema)} ORDER BY table_name`,
  );
  return rows.map((r) => String(r.table_name)).filter((t) => MODULE_TABLES.has(t));
}

/** Writes `schema` as a package directory; returns the written file paths. */
async function writePackage(
  engine: Engine,
  schema: string,
  dir: string,
  crs: Crs | undefined,
  sourceFormat: FormatId | undefined,
): Promise<string[]> {
  const args = [quoteLiteral(schema), quoteLiteral(dir)];
  if (sourceFormat) args.push(`source_format => ${quoteLiteral(sourceFormat)}`);
  if (crs) args.push(`crs => ${quoteLiteral(crsToAuthCode(crs))}`);
  const rows = await engine.query(`SELECT file FROM cityparquet_write(${args.join(", ")})`);
  return rows.map((r) => `${dir.replace(/\/$/, "")}/${String(r.file)}`);
}

/** Builds a package schema from a file source with the extension's routing pragma. */
async function fileToPackageSchema(
  engine: Engine,
  source: Extract<Source, { kind: "file" }>,
  schema: string,
): Promise<void> {
  await resetSchema(engine, schema);
  await engine.exec(`CREATE SCHEMA ${quoteIdent(schema)}`);
  const read = readSql(source.format, source.path, source.options);
  const insertPragma = FORMATS[source.format].insertPragma;
  if (!insertPragma) {
    // No routing pragma (OBJ): every object is the one class read_obj was given
    // (Building by default), so the whole read is the `building` table.
    await engine.exec(`CREATE TABLE ${table(schema, "building")} AS SELECT * FROM ${read}`);
    await engine.exec(`PRAGMA cityparquet_init(${quoteLiteral(schema)})`);
    return;
  }
  // cityparquet_init needs at least one object table, and insert_* cannot create the
  // first one itself (see docs/spike-findings.md), so seed an empty `building`.
  await engine.exec(`CREATE TABLE ${table(schema, "building")} AS SELECT * FROM ${read} LIMIT 0`);
  await engine.exec(`PRAGMA cityparquet_init(${quoteLiteral(schema)})`);
  await engine.exec(
    `PRAGMA ${insertPragma}(${quoteLiteral(schema)}, ${quoteLiteral(source.path)}, create_tables = true)`,
  );
}

/**
 * COPY options that carry a file source's metadata. The CityJSON family states its own
 * CRS and appearance, which `metadata_from` reads back. An OBJ has no CRS: it comes
 * from `obj_metadata` with the caller's CRS (its materials travel on their own).
 */
function sourceMetadata(source: Extract<Source, { kind: "file" }>): Record<string, string> {
  if (source.format !== "obj") return { metadata_from: source.path };
  if (!source.options?.crs) return {};
  return {
    metadata_query: `SELECT reference_system AS crs FROM ${metadataCall("obj", source.path, source.options)}`,
  };
}

/** Target-specific COPY options: an OBJ holds one LoD, the highest one selected. */
function targetOptions(target: FileFormatId, selection: Selection): Record<string, string> {
  if (target !== "obj" || selection.lods.length === 0) return {};
  const highest = [...selection.lods].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )[selection.lods.length - 1]!;
  return { lod: highest };
}

/** The files a COPY wrote: just `output`, or everything in its directory for OBJ. */
async function writtenFiles(
  engine: Engine,
  target: FileFormatId,
  output: string,
): Promise<string[]> {
  if (!FORMATS[target].multiFile) return [output];
  const slash = output.lastIndexOf("/");
  if (slash < 0)
    throw new Error(`${FORMATS[target].label} output needs a directory of its own: ${output}`);
  const rows = await engine.query(
    `SELECT file FROM glob(${quoteLiteral(`${output.slice(0, slash)}/*`)}) ORDER BY file`,
  );
  return rows.map((r) => String(r.file));
}

/** Runs the conversion; returns the paths of the files it wrote. */
export async function convert(engine: Engine, req: ConvertRequest): Promise<string[]> {
  const { info, target, selection, output } = req;
  const { source } = info;

  if (isFileFormat(target)) {
    if (source.kind === "file") {
      await engine.exec(
        copySql({
          columns: selectColumns(info.schema, selection),
          from: readSql(source.format, source.path, source.options),
          to: output,
          format: target,
          options: { ...sourceMetadata(source), ...targetOptions(target, selection) },
        }),
      );
      return writtenFiles(engine, target, output);
    }
    // Package → file: one relation over every module table, by column name.
    const tables = await readPackage(engine, source.dir, WORK_SCHEMA);
    const parts: string[] = [];
    for (const t of tables) {
      const schema = analyzeColumns(await describe(engine, table(WORK_SCHEMA, t)));
      parts.push(selectSql(selectColumns(schema, selection), table(WORK_SCHEMA, t)));
    }
    await engine.exec(
      copySql({
        relation: parts.join(" UNION ALL BY NAME "),
        to: output,
        format: target,
        options: {
          ...(info.crs ? { crs: crsToUri(info.crs) } : {}),
          ...targetOptions(target, selection),
        },
      }),
    );
    await resetSchema(engine, WORK_SCHEMA);
    return writtenFiles(engine, target, output);
  }

  // Target is a package.
  if (source.kind === "file") {
    await fileToPackageSchema(engine, source, WORK_SCHEMA);
  } else {
    await readPackage(engine, source.dir, WORK_SCHEMA);
  }
  await pruneTables(engine, WORK_SCHEMA, await objectTables(engine, WORK_SCHEMA), selection);
  const files = await writePackage(
    engine,
    WORK_SCHEMA,
    output,
    info.crs,
    source.kind === "file" ? source.format : undefined,
  );
  await resetSchema(engine, WORK_SCHEMA);
  return files;
}
