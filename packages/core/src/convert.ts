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

export interface FileSource {
  kind: "file";
  format: FileFormatId;
  path: string;
  /** For formats that carry no LoD or CRS of their own (OBJ). */
  options?: ReadOptions;
}

export type Source =
  | FileSource
  | { kind: "package"; dir: string }
  /** Several files of one dataset, combined into one output. */
  | { kind: "merge"; sources: FileSource[] };

export interface SourceInfo {
  source: Source;
  schema: SourceSchema;
  crs?: Crs;
  /** Object tables of a package source (e.g. ["building"]); empty for files. */
  tables: string[];
  /** CityObjects in the source, when the metadata or the tables say. */
  objects?: number;
  /** For a merge: each input's own info, in input order. */
  inputs?: SourceInfo[];
  /**
   * For a merge: the type a column takes where the inputs inferred different ones
   * (column name → type). Each input is cast to it.
   */
  mergeTypes?: Record<string, string>;
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

async function countRows(engine: Engine, schema: string, tables: string[]): Promise<number> {
  let n = 0;
  for (const t of tables) {
    const [row] = await engine.query(`SELECT count(*) AS n FROM ${table(schema, t)}`);
    n += Number(row?.n ?? 0);
  }
  return n;
}

/**
 * The format a source is in: a package is CityParquet; a merge, its inputs' format when
 * they share one (undefined when they mix formats).
 */
export function sourceFormat(source: Source): FormatId | undefined {
  if (source.kind === "package") return "cityparquet";
  if (source.kind === "file") return source.format;
  const formats = new Set(source.sources.map((s) => s.format));
  return formats.size === 1 ? source.sources[0]!.format : undefined;
}

const crsLabel = (info: SourceInfo) => (info.crs ? crsToAuthCode(info.crs) : "no CRS");
const sourcePath = (info: SourceInfo) =>
  info.source.kind === "file"
    ? info.source.path
    : info.source.kind === "package"
      ? info.source.dir
      : "";

/** Integer and floating-point types, narrowest first: a merge takes the widest. */
const NUMERIC = [
  "TINYINT",
  "UTINYINT",
  "SMALLINT",
  "USMALLINT",
  "INTEGER",
  "UINTEGER",
  "BIGINT",
  "UBIGINT",
  "HUGEINT",
  "FLOAT",
  "DOUBLE",
];

const relationOf = (info: SourceInfo) => {
  const s = info.source as FileSource;
  return readSql(s.format, s.path, s.options);
};

/**
 * The one type for a column the inputs inferred differently. Readers infer attribute
 * types from a sample of lines, so tiles of one dataset can disagree with the same kind
 * of values. Inputs holding no value in the column take any type; numbers of different
 * widths take the widest; text whose every value reads as the other input's type takes
 * that type. Anything else is a real conflict, and refused.
 */
async function resolveType(
  engine: Engine,
  name: string,
  entries: { input: SourceInfo; type: string }[],
): Promise<string> {
  const column = quoteIdent(name);
  const live: typeof entries = [];
  for (const e of entries) {
    const [row] = await engine.query(`SELECT count(${column}) AS n FROM ${relationOf(e.input)}`);
    if (Number(row?.n ?? 0) > 0) live.push(e);
  }
  const types = [...new Set(live.map((e) => e.type))];
  if (types.length <= 1) return types[0] ?? entries[0]!.type;
  if (types.every((t) => NUMERIC.includes(t))) {
    return types.reduce((a, b) => (NUMERIC.indexOf(a) >= NUMERIC.indexOf(b) ? a : b));
  }
  const conflict = (a: (typeof entries)[number], b: (typeof entries)[number]) =>
    new Error(
      `Column "${name}" is ${a.type} in ${sourcePath(a.input)} but ${b.type} in ` +
        `${sourcePath(b.input)}; the inputs do not share a schema.`,
    );
  const typed = types.filter((t) => t !== "VARCHAR");
  if (typed.length !== 1 || !types.includes("VARCHAR")) {
    throw conflict(
      live.find((e) => e.type === types[0])!,
      live.find((e) => e.type === types[1])!,
    );
  }
  const target = typed[0]!;
  const other = live.find((e) => e.type === target)!;
  for (const e of live.filter((x) => x.type === "VARCHAR")) {
    const [row] = await engine.query(
      `SELECT count(*) AS n FROM ${relationOf(e.input)} ` +
        `WHERE ${column} IS NOT NULL AND TRY_CAST(${column} AS ${target}) IS NULL`,
    );
    if (Number(row?.n ?? 0) > 0) throw conflict(e, other);
  }
  return target;
}

/**
 * Inspects each input of a merge and refuses what cannot be combined without guessing:
 * inputs in different CRSs (a merge does not reproject) and a column whose values differ
 * in kind between inputs (see resolveType). A column only some inputs have is fine: the
 * others fill it with NULL.
 */
async function inspectMerge(
  engine: Engine,
  source: Extract<Source, { kind: "merge" }>,
): Promise<SourceInfo> {
  if (source.sources.length < 2) throw new Error("A merge needs at least two inputs.");
  const inputs: SourceInfo[] = [];
  for (const s of source.sources) inputs.push(await inspect(engine, s));

  const first = inputs[0]!;
  for (const other of inputs.slice(1)) {
    if (crsLabel(other) !== crsLabel(first)) {
      throw new Error(
        `Inputs disagree on CRS: ${sourcePath(first)} is ${crsLabel(first)}, ` +
          `${sourcePath(other)} is ${crsLabel(other)}. A merge does not reproject.`,
      );
    }
  }

  // Every column, first occurrence first, with the inputs that have it and their types.
  const byName = new Map<string, { input: SourceInfo; type: string }[]>();
  for (const input of inputs) {
    for (const column of input.schema.columns) {
      const entries = byName.get(column.name) ?? [];
      entries.push({ input, type: column.type });
      byName.set(column.name, entries);
    }
  }
  const columns: Column[] = [];
  const mergeTypes: Record<string, string> = {};
  for (const [name, entries] of byName) {
    let type = entries[0]!.type;
    if (entries.some((e) => e.type !== type)) {
      type = await resolveType(engine, name, entries);
      mergeTypes[name] = type;
    }
    columns.push({ name, type });
  }

  const counts = inputs.map((i) => i.objects);
  return {
    source,
    schema: analyzeColumns(columns),
    crs: first.crs,
    tables: [],
    objects: counts.every((n) => n !== undefined) ? counts.reduce((a, b) => a + b, 0) : undefined,
    inputs,
    mergeTypes,
  };
}

export async function inspect(engine: Engine, source: Source): Promise<SourceInfo> {
  if (source.kind === "merge") return inspectMerge(engine, source);
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
      objects: meta?.city_objects_count == null ? undefined : Number(meta.city_objects_count),
    };
  }
  const tables = await readPackage(engine, source.dir, INSPECT_SCHEMA);
  const info: SourceInfo = {
    source,
    schema: analyzeColumns(await unionColumns(engine, INSPECT_SCHEMA, tables)),
    crs: await packageCrs(engine, INSPECT_SCHEMA),
    tables,
    objects: await countRows(engine, INSPECT_SCHEMA, tables),
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
  source: FileSource,
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
function sourceMetadata(source: FileSource): Record<string, string> {
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

/** The files in the directory a path lives in ("" for the working directory). */
async function listDirectory(engine: Engine, path: string): Promise<string[]> {
  const slash = path.lastIndexOf("/");
  const pattern = slash < 0 ? "*" : `${path.slice(0, slash)}/*`;
  const rows = await engine.query(`SELECT file FROM glob(${quoteLiteral(pattern)})`);
  return rows.map((r) => String(r.file));
}

/**
 * Runs a COPY and returns the files it wrote. A multi-file target (OBJ) writes sidecars
 * beside `output` -- its .mtl and texture images, named by the data -- so the directory
 * is listed before and after: the result is `output`, its `.mtl` and whatever appeared,
 * never what was already there.
 */
async function copyAndCollect(
  engine: Engine,
  target: FileFormatId,
  output: string,
  copy: string,
): Promise<string[]> {
  if (!FORMATS[target].multiFile) {
    await engine.exec(copy);
    return [output];
  }
  const before = new Set(await listDirectory(engine, output));
  await engine.exec(copy);
  const mtl = output.replace(/\.[^./]*$/, "") + ".mtl";
  const written = new Set([output, mtl]);
  for (const file of await listDirectory(engine, output)) {
    if (!before.has(file)) written.add(file);
  }
  return [...written];
}

/** Refuses an id that more than one input holds: a merge expects each object once. */
async function checkUniqueIds(engine: Engine, sources: FileSource[]): Promise<void> {
  const ids = sources
    .map((s) => `SELECT id FROM ${readSql(s.format, s.path, s.options)}`)
    .join(" UNION ALL ");
  const rows = await engine.query(
    `SELECT id FROM (${ids}) GROUP BY id HAVING count(*) > 1 ORDER BY id LIMIT 5`,
  );
  if (rows.length > 0) {
    const list = rows.map((r) => String(r.id)).join(", ");
    throw new Error(
      `Duplicate ${rows.length > 1 ? "ids" : "id"} across the inputs (${list}${rows.length === 5 ? ", …" : ""}): ` +
        "a merge expects each object in exactly one input.",
    );
  }
}

/**
 * Refuses materials and textures in a merge: their cells index each file's own
 * appearance list, so rows from different files cannot share one output's list.
 */
async function checkNoAppearance(
  engine: Engine,
  inputs: SourceInfo[],
  selection: Selection,
): Promise<void> {
  for (const input of inputs) {
    const source = input.source as FileSource;
    const columns = selectColumns(input.schema, selection).filter((c) =>
      /^(material|texture)_lod/.test(c),
    );
    if (columns.length === 0) continue;
    const [row] = await engine.query(
      `SELECT count(*) AS n FROM ${readSql(source.format, source.path, source.options)} ` +
        `WHERE ${columns.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(" OR ")}`,
    );
    if (Number(row?.n ?? 0) > 0) {
      throw new Error(
        `${source.path} has materials or textures. Merging inputs with appearances is not ` +
          "supported yet: their ids are per file. Convert the inputs one by one instead.",
      );
    }
  }
}

/** Adds one more file source to a package schema built by fileToPackageSchema. */
async function insertIntoPackage(
  engine: Engine,
  source: FileSource,
  schema: string,
): Promise<void> {
  const insertPragma = FORMATS[source.format].insertPragma;
  if (insertPragma) {
    await engine.exec(
      `PRAGMA ${insertPragma}(${quoteLiteral(schema)}, ${quoteLiteral(source.path)}, create_tables = true)`,
    );
    return;
  }
  await engine.exec(
    `INSERT INTO ${table(schema, "building")} BY NAME SELECT * FROM ${readSql(source.format, source.path, source.options)}`,
  );
}

async function convertMerge(
  engine: Engine,
  req: ConvertRequest,
  source: Extract<Source, { kind: "merge" }>,
): Promise<string[]> {
  const { info, target, selection, output } = req;
  if (!info.inputs) throw new Error("Inspect a merge before converting it.");
  await checkUniqueIds(engine, source.sources);
  await checkNoAppearance(engine, info.inputs, selection);

  if (isFileFormat(target)) {
    // One relation over every input, by column name: a column one input lacks is NULL,
    // and a column the inputs typed differently is cast to the type the merge settled on.
    const types = info.mergeTypes ?? {};
    const relation = info.inputs
      .map((input) => {
        const own = new Map(input.schema.columns.map((c) => [c.name, c.type]));
        const list = selectColumns(input.schema, selection).map((c) => {
          const type = types[c];
          return type && own.get(c) !== type
            ? `CAST(${quoteIdent(c)} AS ${type}) AS ${quoteIdent(c)}`
            : quoteIdent(c);
        });
        return `SELECT ${list.join(", ")} FROM ${relationOf(input)}`;
      })
      .join(" UNION ALL BY NAME ");
    // No metadata_from: one input's extent and title would misdescribe the whole.
    return copyAndCollect(
      engine,
      target,
      output,
      copySql({
        relation,
        to: output,
        format: target,
        options: {
          ...(info.crs ? { crs: crsToUri(info.crs) } : {}),
          ...targetOptions(target, selection),
        },
      }),
    );
  }

  const [first, ...rest] = source.sources;
  await fileToPackageSchema(engine, first!, WORK_SCHEMA);
  for (const s of rest) await insertIntoPackage(engine, s, WORK_SCHEMA);
  const tables = await objectTables(engine, WORK_SCHEMA);
  // insert_* coerces an incoming column to the type already in the table; give each
  // column the type the merge settled on instead.
  for (const [name, type] of Object.entries(info.mergeTypes ?? {})) {
    for (const t of tables) {
      const has = (await describe(engine, table(WORK_SCHEMA, t))).find((c) => c.name === name);
      if (has && has.type !== type) {
        await engine.exec(
          `ALTER TABLE ${table(WORK_SCHEMA, t)} ALTER COLUMN ${quoteIdent(name)} ` +
            `SET DATA TYPE ${type} USING TRY_CAST(${quoteIdent(name)} AS ${type})`,
        );
      }
    }
  }
  await pruneTables(engine, WORK_SCHEMA, tables, selection);
  const formats = new Set(source.sources.map((s) => s.format));
  const files = await writePackage(
    engine,
    WORK_SCHEMA,
    output,
    info.crs,
    formats.size === 1 ? first!.format : undefined,
  );
  await resetSchema(engine, WORK_SCHEMA);
  return files;
}

/** Runs the conversion; returns the paths of the files it wrote. */
export async function convert(engine: Engine, req: ConvertRequest): Promise<string[]> {
  const { info, target, selection, output } = req;
  const { source } = info;
  if (source.kind === "merge") return convertMerge(engine, req, source);

  if (isFileFormat(target)) {
    if (source.kind === "file") {
      return copyAndCollect(
        engine,
        target,
        output,
        copySql({
          columns: selectColumns(info.schema, selection),
          from: readSql(source.format, source.path, source.options),
          to: output,
          format: target,
          options: { ...sourceMetadata(source), ...targetOptions(target, selection) },
        }),
      );
    }
    // Package → file: one relation over every module table, by column name.
    const tables = await readPackage(engine, source.dir, WORK_SCHEMA);
    const parts: string[] = [];
    for (const t of tables) {
      const schema = analyzeColumns(await describe(engine, table(WORK_SCHEMA, t)));
      parts.push(selectSql(selectColumns(schema, selection), table(WORK_SCHEMA, t)));
    }
    const files = await copyAndCollect(
      engine,
      target,
      output,
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
    return files;
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
