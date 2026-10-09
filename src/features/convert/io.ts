// Turns what the user dropped or pasted into files DuckDB can read, and what the
// extension wrote into one download.
import { unzipSync, zipSync } from "fflate";
import type { Source } from "@/core/convert";
import { baseName, detectFormat, isPackagePath } from "@/core/detect";
import { FORMATS, type FormatId } from "@/core/formats";
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
}

export class InputError extends Error {}

const INPUT_DIR = "input";
const PACKAGE_DIR = `${INPUT_DIR}/package`;
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

async function registerPackage(
  engine: BrowserEngine,
  files: { name: string; bytes: Uint8Array }[],
  name: string,
): Promise<PreparedInput> {
  const parts = files.filter((f) => isPackagePath(f.name));
  if (!parts.some((f) => f.name.toLowerCase().endsWith(".parquet"))) {
    throw new InputError("No CityParquet module files (*.parquet) found in this package.");
  }
  // Measure before registering: registerFileBuffer transfers (detaches) the buffer.
  const bytes = parts.reduce((n, f) => n + f.bytes.byteLength, 0);
  const registered: string[] = [];
  for (const f of parts) {
    const path = `${PACKAGE_DIR}/${fileName(f.name)}`;
    await engine.registerFile(path, f.bytes);
    registered.push(path);
  }
  return {
    source: { kind: "package", dir: PACKAGE_DIR },
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
      `Can't tell what "${name}" is. Supported: CityJSON, CityJSONSeq, FlatCityBuf, ` +
        "or a CityParquet package (folder or .zip).",
    );
  }
  if (format === "cityparquet") {
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const files = isZip
      ? Object.entries(unzipSync(bytes))
          .filter(([path]) => !path.endsWith("/") && !path.startsWith("__MACOSX/"))
          .map(([path, data]) => ({ name: path, bytes: data }))
      : [{ name, bytes }];
    return registerPackage(engine, files, name);
  }
  const path = `${INPUT_DIR}/source${FORMATS[format].extension}`;
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

export async function prepareInput(
  engine: BrowserEngine,
  input: InputSelection,
): Promise<PreparedInput> {
  if (input.kind === "url") {
    const { name, bytes } = await download(input.url);
    return registerSingle(engine, name, bytes);
  }
  const { files } = input;
  if (files.length === 0) throw new InputError("Nothing to convert: no files were dropped.");
  if (files.length === 1) {
    const [file] = files;
    return registerSingle(engine, file!.name, new Uint8Array(await file!.arrayBuffer()));
  }
  // Several files: a CityParquet package folder.
  const loaded = await Promise.all(
    files.map(async (f) => ({
      name: f.webkitRelativePath || f.name,
      bytes: new Uint8Array(await f.arrayBuffer()),
    })),
  );
  const folder = files[0]!.webkitRelativePath.split("/")[0] || "package";
  return registerPackage(engine, loaded, folder);
}

/** Where the extension writes: a file path, or a directory for a package. */
export function outputPath(input: PreparedInput, target: FormatId): string {
  const base = baseName(input.name).replace(/[^\w.-]+/g, "_");
  // Files go at the virtual-FS root: DuckDB-Wasm has no real directories to create.
  return FORMATS[target].kind === "package"
    ? `output_${base}`
    : `output_${base}${FORMATS[target].extension}`;
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

/** Reads the written files back; a package becomes one zip with a top-level folder. */
export async function collectOutput(
  engine: BrowserEngine,
  files: string[],
  input: PreparedInput,
  target: FormatId,
): Promise<Download> {
  const base = baseName(input.name);
  if (FORMATS[target].kind === "file") {
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
    fileName: `${base}.zip`,
  };
}
