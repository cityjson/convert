// The Node library API: convert or inspect files by path or URL. The CLI is a thin
// wrapper over these two functions.
import {
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  FORMATS,
  convert,
  detectFormat,
  inspect,
  type Crs,
  type FileSource,
  type FormatId,
  type ReadOptions,
  type Source,
  type SourceInfo,
} from "@cityjson/cjconv-core";
import { createNodeEngine, type NodeEngine, type NodeEngineOptions } from "./engine";

/** An error meant for the user: bad input, a refused overwrite, an unknown LoD. */
export class CjconvError extends Error {}

export interface SourceOptions extends NodeEngineOptions {
  /** The input format, when its name and content do not say. */
  from?: FormatId;
  /** OBJ states no LoD or CRS: the LoD to read it as (default "2.2") and its CRS. */
  obj?: { lod?: string; crs?: string };
  /** An engine to reuse; otherwise one is created and closed for the call. */
  engine?: NodeEngine;
}

export interface ConvertFileOptions extends SourceOptions {
  /** One input, or several files of one dataset to combine into one output. */
  input: string | string[];
  /** A file path, or a directory for a CityParquet package. */
  output: string;
  /** The output format; by default taken from the output name. */
  to?: FormatId;
  /** LoDs to keep, e.g. ["2.2"]. Default: all. */
  lods?: string[];
  /** Attributes to keep. Default: all; [] keeps none. */
  attributes?: string[];
  /** Overwrite an existing output. */
  force?: boolean;
}

export interface ConvertFileResult {
  source: SourceInfo;
  target: FormatId;
  /** Every file written. */
  files: string[];
}

const SNIFF_BYTES = 64 * 1024;

const isUrl = (input: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(input);

function readHead(file: string): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const buf = new Uint8Array(SNIFF_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, SNIFF_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/** "EPSG:7415", "7415" or "epsg:7415" → { authority: "EPSG", code: "7415" }. */
export function parseCrs(text: string): Crs {
  const m = /^(?:([A-Za-z]+):)?(\d+)$/.exec(text.trim());
  if (!m) throw new CjconvError(`Can't read CRS "${text}": give it as EPSG:7415 or 7415.`);
  return { authority: (m[1] ?? "EPSG").toUpperCase(), code: m[2]! };
}

function readOptions(format: FormatId, options: SourceOptions): ReadOptions | undefined {
  if (format !== "obj") return undefined;
  return {
    lod: options.obj?.lod ?? "2.2",
    ...(options.obj?.crs ? { crs: parseCrs(options.obj.crs) } : {}),
  };
}

/** Works out what an input is: a file of some format, or a package directory. */
function resolveSource(input: string, options: SourceOptions): Source {
  if (isUrl(input)) {
    const format = options.from ?? detectFormat(input);
    if (!format)
      throw new CjconvError(`Can't tell the format of ${input} from its name; use --from.`);
    if (format === "cityparquet") {
      throw new CjconvError("A CityParquet package is read from a local directory, not a URL.");
    }
    return { kind: "file", format, path: input, options: readOptions(format, options) };
  }
  if (!existsSync(input)) throw new CjconvError(`No such file or directory: ${input}`);
  if (statSync(input).isDirectory()) {
    if (!readdirSync(input).some((f) => f.toLowerCase().endsWith(".parquet"))) {
      throw new CjconvError(
        `${input} is a directory with no CityParquet module files (*.parquet).`,
      );
    }
    return { kind: "package", dir: input };
  }
  const format = options.from ?? detectFormat(input, readHead(input));
  if (!format) {
    throw new CjconvError(
      `Can't tell what ${input} is. Supported: CityJSON, CityJSONSeq, FlatCityBuf, OBJ, ` +
        "or a CityParquet package directory; or name the format with --from.",
    );
  }
  if (format === "cityparquet") {
    throw new CjconvError(
      `${input} is a single file, but a CityParquet package is a directory: pass the directory` +
        (input.toLowerCase().endsWith(".zip") ? " (unzip it first)." : " that holds it."),
    );
  }
  return { kind: "file", format, path: input, options: readOptions(format, options) };
}

/** The output format: --to, else a trailing slash or an existing directory, else the name. */
function resolveTarget(output: string, to: FormatId | undefined): FormatId {
  if (to) return to;
  if (/[/\\]$/.test(output) || (existsSync(output) && statSync(output).isDirectory())) {
    return "cityparquet";
  }
  const format = detectFormat(output);
  if (format === "cityparquet") {
    throw new CjconvError(
      "A CityParquet package is written as a directory: give a directory path (e.g. out/) or --to cityparquet.",
    );
  }
  if (!format) {
    throw new CjconvError(`Can't tell the output format from "${output}"; use --to <format>.`);
  }
  return format;
}

async function requireObjSupport(engine: NodeEngine): Promise<void> {
  if (!(await engine.hasFunction("read_obj"))) {
    throw new CjconvError(
      "This cityjson extension build has no OBJ support (the community build predates it). " +
        "Load a newer build with --extension <path to cityjson.duckdb_extension>.",
    );
  }
}

function checkSelection(info: SourceInfo, lods?: string[], attributes?: string[]): void {
  const missingLods = (lods ?? []).filter((l) => !info.schema.lods.includes(l));
  if (missingLods.length > 0) {
    throw new CjconvError(
      `No LoD ${missingLods.join(", ")} in the input. It has: ${info.schema.lods.join(", ") || "none"}.`,
    );
  }
  const known = new Set(info.schema.attributes.map((a) => a.name));
  const unknown = (attributes ?? []).filter((a) => !known.has(a));
  if (unknown.length > 0) {
    throw new CjconvError(
      `No attribute ${unknown.join(", ")} in the input. Run \`cjconv info\` to list them.`,
    );
  }
}

/** Refuses to clobber, and creates the directories the output needs. */
function prepareOutput(output: string, target: FormatId, force: boolean): string {
  const clean = output.replace(/[/\\]+$/, "");
  if (FORMATS[target].kind === "package") {
    if (existsSync(clean) && readdirSync(clean).length > 0 && !force) {
      throw new CjconvError(`${clean} exists and is not empty; use --force to write into it.`);
    }
    mkdirSync(clean, { recursive: true });
    return clean;
  }
  if (existsSync(clean) && !force) {
    throw new CjconvError(`${clean} exists; use --force to overwrite it.`);
  }
  mkdirSync(path.dirname(clean), { recursive: true });
  return clean;
}

async function withEngine<T>(
  options: SourceOptions,
  fn: (engine: NodeEngine) => Promise<T>,
): Promise<T> {
  const engine = options.engine ?? (await createNodeEngine(options));
  try {
    return await fn(engine);
  } finally {
    if (!options.engine) engine.close();
  }
}

/**
 * One input as itself; several as a merge. A merge combines files (not package
 * directories) of one dataset; its checks run when it is inspected and converted.
 */
function resolveInputs(input: string | string[], options: SourceOptions): Source {
  const inputs = typeof input === "string" ? [input] : input;
  if (inputs.length === 0) throw new CjconvError("No input given.");
  if (inputs.length === 1) return resolveSource(inputs[0]!, options);
  const sources = inputs.map((i) => resolveSource(i, options));
  const packages = sources.filter((s) => s.kind !== "file");
  if (packages.length > 0) {
    throw new CjconvError(
      "Several inputs are combined file by file; a CityParquet package directory cannot be one of them.",
    );
  }
  return { kind: "merge", sources: sources as FileSource[] };
}

const usesObj = (source: Source) =>
  source.kind === "file"
    ? source.format === "obj"
    : source.kind === "merge" && source.sources.some((s) => s.format === "obj");

/** What an input (or several, combined) holds: format, CRS, LoDs, attributes, object count. */
export async function inspectFile(
  input: string | string[],
  options: SourceOptions = {},
): Promise<SourceInfo> {
  const source = resolveInputs(input, options);
  return withEngine(options, async (engine) => {
    if (usesObj(source)) await requireObjSupport(engine);
    return inspect(engine, source);
  });
}

/**
 * Converts `input` to `output`, keeping the chosen LoDs and attributes. Several inputs
 * are combined into the one output; an id in more than one input, a column typed
 * differently between them, or different CRSs are refused.
 */
export async function convertFile(options: ConvertFileOptions): Promise<ConvertFileResult> {
  const source = resolveInputs(options.input, options);
  const target = resolveTarget(options.output, options.to);
  return withEngine(options, async (engine) => {
    if (usesObj(source) || target === "obj") await requireObjSupport(engine);
    const info = await inspect(engine, source);
    checkSelection(info, options.lods, options.attributes);
    const output = prepareOutput(options.output, target, options.force ?? false);
    const files = await convert(engine, {
      info,
      target,
      selection: {
        lods: options.lods ?? info.schema.lods,
        attributes: options.attributes ?? info.schema.attributes.map((a) => a.name),
      },
      output,
    });
    return { source: info, target, files };
  });
}
