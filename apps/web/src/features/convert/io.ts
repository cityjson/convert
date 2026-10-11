// Turns what the user dropped or pasted into files DuckDB can read, and what the
// extension wrote into one download.
import { unzipSync, zipSync } from "fflate";
import {
  FORMATS,
  baseName,
  detectFormat,
  isObjSidecar,
  isPackagePath,
  type FileSource,
  type FormatId,
  type ReadOptions,
  type Source,
  sourceFormat,
} from "@cityjson/cjconv-core";
import type { BrowserEngine } from "@/engine/duckdb";

export type InputSelection = { kind: "files"; files: File[] } | { kind: "url"; url: string };

export interface PreparedInput {
  source: Source;
  format: FormatId;
  /** Shown to the user, and the base of the output name. */
  name: string;
  bytes: number;
  /** Virtual-FS paths to drop when the input is replaced. */
  registered: string[];
  /** For a merge: the inputs being combined, in order. */
  parts?: PreparedInput[];
}

export class InputError extends Error {}

const INPUT_DIR = "input";

// Every registered input gets a directory of its own, so adding a second file can never
// overwrite the first in the virtual file system.
let nextSlot = 0;
const newSlot = () => `${INPUT_DIR}/${nextSlot++}`;

/**
 * An OBJ states no LoD or CRS. Its geometry is read as LoD 2.2 until the user says
 * otherwise, and its CRS stays unknown unless they give one.
 */
export const DEFAULT_OBJ_OPTIONS: ReadOptions = { lod: "2.2" };

type NamedBytes = { name: string; bytes: Uint8Array };
const SNIFF_BYTES = 64 * 1024;

const fileName = (path: string) => path.split("/").pop()!;

async function download(url: string): Promise<{ name: string; bytes: Uint8Array }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new InputError(
      "Couldn't download that URL. The server may not allow cross-origin requests (CORS), " +
        "or it is unreachable. Download the file and drop it here instead.",
    );
  }
  if (!res.ok) throw new InputError(`Download failed: ${res.status} ${res.statusText}`.trim());
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "download");
  return { name, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/**
 * Registers an OBJ with the files that travel with it (.mtl, texture images) side by
 * side, so read_obj finds them the way it would on disk: relative to the .obj.
 */
async function registerObj(engine: BrowserEngine, files: NamedBytes[]): Promise<PreparedInput> {
  const objs = files.filter((f) => f.name.toLowerCase().endsWith(".obj"));
  if (objs.length !== 1) {
    throw new InputError(
      `Drop one OBJ at a time (with its .mtl and textures); found ${objs.length}.`,
    );
  }
  const parts = [objs[0]!, ...files.filter((f) => isObjSidecar(f.name))];
  const bytes = parts.reduce((n, f) => n + f.bytes.byteLength, 0); // before registering detaches
  const dir = newSlot();
  const registered: string[] = [];
  for (const f of parts) {
    const path = `${dir}/${fileName(f.name)}`;
    await engine.registerFile(path, f.bytes);
    registered.push(path);
  }
  return {
    source: { kind: "file", format: "obj", path: registered[0]!, options: DEFAULT_OBJ_OPTIONS },
    format: "obj",
    name: fileName(objs[0]!.name),
    bytes,
    registered,
  };
}

const hasObj = (files: NamedBytes[]) => files.some((f) => f.name.toLowerCase().endsWith(".obj"));

async function registerPackage(
  engine: BrowserEngine,
  files: NamedBytes[],
  name: string,
): Promise<PreparedInput> {
  const parts = files.filter((f) => isPackagePath(f.name));
  if (!parts.some((f) => f.name.toLowerCase().endsWith(".parquet"))) {
    throw new InputError("No CityParquet module files (*.parquet) found in this package.");
  }
  // Measure before registering: registerFileBuffer transfers (detaches) the buffer.
  const bytes = parts.reduce((n, f) => n + f.bytes.byteLength, 0);
  const dir = newSlot();
  const registered: string[] = [];
  for (const f of parts) {
    const path = `${dir}/${fileName(f.name)}`;
    await engine.registerFile(path, f.bytes);
    registered.push(path);
  }
  return {
    source: { kind: "package", dir },
    format: "cityparquet",
    name,
    bytes,
    registered,
  };
}

async function registerSingle(
  engine: BrowserEngine,
  name: string,
  bytes: Uint8Array,
): Promise<PreparedInput> {
  const format = detectFormat(name, bytes.subarray(0, SNIFF_BYTES));
  if (!format) {
    throw new InputError(
      `Can't tell what "${name}" is. Supported: CityJSON, CityJSONSeq, FlatCityBuf, OBJ, ` +
        "or a CityParquet package (folder or .zip).",
    );
  }
  if (format === "obj") return registerObj(engine, [{ name, bytes }]);
  if (format === "cityparquet") {
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const files = isZip
      ? Object.entries(unzipSync(bytes))
          .filter(([path]) => !path.endsWith("/") && !path.startsWith("__MACOSX/"))
          .map(([path, data]) => ({ name: path, bytes: data }))
      : [{ name, bytes }];
    // A zip holds either an OBJ with its sidecars, or a CityParquet package.
    return hasObj(files) ? registerObj(engine, files) : registerPackage(engine, files, name);
  }
  const path = `${newSlot()}/source${FORMATS[format].extension}`;
  const size = bytes.byteLength; // before registerFileBuffer detaches the buffer
  await engine.registerFile(path, bytes);
  return {
    source: { kind: "file", format, path },
    format,
    name,
    bytes: size,
    registered: [path],
  };
}

/** Whether an input can be one of several combined into one output. */
export const canCombine = (input: PreparedInput) =>
  input.source.kind === "file" && input.format !== "obj";

/**
 * Registers what the user chose. Usually one input; several files that are each
 * CityJSON, CityJSONSeq or FlatCityBuf are several inputs, for combineInputs.
 */
export async function prepareInputs(
  engine: BrowserEngine,
  input: InputSelection,
): Promise<PreparedInput[]> {
  if (input.kind === "url") {
    const { name, bytes } = await download(input.url);
    return [await registerSingle(engine, name, bytes)];
  }
  const { files } = input;
  if (files.length === 0) throw new InputError("Nothing to convert: no files were dropped.");
  if (files.length === 1) {
    const [file] = files;
    return [await registerSingle(engine, file!.name, new Uint8Array(await file!.arrayBuffer()))];
  }
  // Several files: an OBJ with its .mtl and textures, a CityParquet package folder, or
  // several files of one dataset.
  const loaded = await Promise.all(
    files.map(async (f) => ({
      name: f.webkitRelativePath || f.name,
      bytes: new Uint8Array(await f.arrayBuffer()),
    })),
  );
  if (hasObj(loaded)) return [await registerObj(engine, loaded)];
  if (loaded.some((f) => f.name.toLowerCase().endsWith(".parquet"))) {
    const folder = files[0]!.webkitRelativePath.split("/")[0] || "package";
    return [await registerPackage(engine, loaded, folder)];
  }
  const inputs: PreparedInput[] = [];
  try {
    for (const f of loaded) {
      const one = await registerSingle(engine, fileName(f.name), f.bytes);
      inputs.push(one);
      if (!canCombine(one)) {
        throw new InputError(
          `${one.name} can't be combined with other files: only CityJSON, CityJSONSeq and ` +
            "FlatCityBuf files are merged.",
        );
      }
    }
  } catch (e) {
    await engine.dropFiles(inputs.flatMap((i) => i.registered));
    throw e;
  }
  return inputs;
}

/**
 * One input as itself; several combined into a merge (one output). Their checks --
 * unique ids, one CRS, one schema -- run when the merge is inspected and converted.
 */
export function combineInputs(inputs: PreparedInput[]): PreparedInput {
  if (inputs.length === 0) throw new InputError("Nothing to convert.");
  if (inputs.length === 1) return inputs[0]!;
  const sources: FileSource[] = [];
  for (const input of inputs) {
    if (!canCombine(input) || input.source.kind !== "file") {
      throw new InputError(
        `${input.name} can't be combined with other files: only CityJSON, CityJSONSeq and ` +
          "FlatCityBuf files are merged.",
      );
    }
    sources.push(input.source);
  }
  const source: Source = { kind: "merge", sources };
  return {
    source,
    format: sourceFormat(source) ?? sources[0]!.format,
    name: `${baseName(inputs[0]!.name)}_merged`,
    bytes: inputs.reduce((n, i) => n + i.bytes, 0),
    registered: inputs.flatMap((i) => i.registered),
    parts: inputs,
  };
}

/**
 * An error message with the virtual-FS paths the core reports (`input/3/source.city.jsonl`)
 * replaced by the names the user knows those inputs by.
 */
export function withInputNames(message: string, input: PreparedInput | undefined): string {
  let out = message;
  for (const part of input ? (input.parts ?? [input]) : []) {
    const path = part.source.kind === "file" ? part.source.path : undefined;
    if (path) out = out.replaceAll(path, part.name);
  }
  return out;
}

/**
 * Where the extension writes: a file path, a directory for a package, or a file in a
 * directory of its own for a format that writes sidecars beside it (OBJ).
 */
export function outputPath(input: PreparedInput, target: FormatId): string {
  const base = baseName(input.name).replace(/[^\w.-]+/g, "_");
  const format = FORMATS[target];
  if (format.kind === "package") return `output_${base}`;
  if (format.multiFile) return `output_${base}/${base}${format.extension}`;
  return `output_${base}${format.extension}`;
}

export interface Download {
  blob: Blob;
  fileName: string;
}

/**
 * Reads a file the extension wrote, refusing an empty one: in the browser, writers that
 * bypass DuckDB's file system leave the target empty (docs/spike-findings.md, bug 1),
 * and an empty download would look like success.
 */
async function readOutput(engine: BrowserEngine, path: string): Promise<Uint8Array> {
  const bytes = await engine.readFile(path);
  if (bytes.byteLength <= 1) {
    throw new Error(
      `The converter wrote an empty ${fileName(path)}. Writing this format does not work in ` +
        "the browser with the current cityjson extension build yet.",
    );
  }
  return bytes;
}

/**
 * Reads the written files back. One file downloads as itself; several (a package, or an
 * OBJ with its .mtl and textures) become one zip with a top-level folder.
 */
export async function collectOutput(
  engine: BrowserEngine,
  files: string[],
  input: PreparedInput,
  target: FormatId,
): Promise<Download> {
  const base = baseName(input.name);
  if (files.length === 1 && FORMATS[target].kind === "file") {
    const bytes = await readOutput(engine, files[0]!);
    return {
      blob: new Blob([bytes as Uint8Array<ArrayBuffer>]),
      fileName: `${base}${FORMATS[target].extension}`,
    };
  }
  const entries: Record<string, Uint8Array> = {};
  for (const path of files) entries[`${base}/${fileName(path)}`] = await readOutput(engine, path);
  return {
    blob: new Blob([zipSync(entries, { level: 0 }) as Uint8Array<ArrayBuffer>], {
      type: "application/zip",
    }),
    fileName: FORMATS[target].kind === "package" ? `${base}.zip` : `${base}-${target}.zip`,
  };
}
