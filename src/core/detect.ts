import type { FormatId } from "./formats";

// Longest suffix first, so ".city.jsonl" wins over ".jsonl" and ".json".
const BY_EXTENSION: [string, FormatId][] = [
  [".city.jsonl", "cityjsonseq"],
  [".city.json", "cityjson"],
  [".jsonl", "cityjsonseq"],
  [".json", "cityjson"],
  [".fcb", "flatcitybuf"],
  [".parquet", "cityparquet"],
  [".zip", "cityparquet"],
];

/** The path part of a file name or URL, lower-cased, without query or fragment. */
function basePath(name: string): string {
  return name.split(/[?#]/)[0]!.toLowerCase();
}

function detectByName(name: string): FormatId | undefined {
  const path = basePath(name);
  return BY_EXTENSION.find(([ext]) => path.endsWith(ext))?.[1];
}

function startsWith(head: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => head[i] === b);
}

function sniff(head: Uint8Array): FormatId | undefined {
  if (startsWith(head, [0x66, 0x63, 0x62, 0x01])) return "flatcitybuf"; // "fcb\x01"
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "cityparquet"; // zip: a package archive
  if (startsWith(head, [0x50, 0x41, 0x52, 0x31])) return "cityparquet"; // "PAR1": a module file

  const text = new TextDecoder().decode(head).replace(/^﻿/, "").trimStart();
  if (!text.startsWith("{")) return undefined;
  // CityJSONSeq: a CityJSON header line, then one CityJSONFeature per line.
  if (/"type"\s*:\s*"CityJSONFeature"/.test(text)) return "cityjsonseq";
  if (/"type"\s*:\s*"CityJSON"/.test(text)) return "cityjson";
  return undefined;
}

/**
 * Detects the input format. File content (the first few KB, when given) is trusted
 * over the name, because `.json` may hold CityJSONSeq and URLs often lack extensions.
 */
export function detectFormat(name: string, head?: Uint8Array): FormatId | undefined {
  return (head && sniff(head)) ?? detectByName(name);
}

/** A file name or URL without directories, query and format extension: the output base name. */
export function baseName(name: string): string {
  const file = name.split(/[?#]/)[0]!.split("/").pop() ?? "";
  const lower = file.toLowerCase();
  const ext = BY_EXTENSION.find(([e]) => lower.endsWith(e))?.[0];
  return (ext ? file.slice(0, -ext.length) : file) || "citymodel";
}

/** Whether a path belongs to a CityParquet package directory. */
export function isPackagePath(path: string): boolean {
  const name = path.split("/").pop()!.toLowerCase();
  return name.endsWith(".parquet") || name === "metadata.json";
}

/** The schema table a package module file loads into, e.g. `water_body.parquet` → `water_body`. */
export function packageTableName(path: string): string | undefined {
  const name = path.split("/").pop()!;
  return name.toLowerCase().endsWith(".parquet") ? name.slice(0, -".parquet".length) : undefined;
}
