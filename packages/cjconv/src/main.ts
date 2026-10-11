// The cjconv command line. main() returns an exit code: 0 done, 1 a problem with the
// input or output, 2 a usage error.
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  FORMATS,
  FORMAT_IDS,
  crsToAuthCode,
  sourceFormat,
  type FormatId,
  type SourceInfo,
} from "@cityjson/cjconv-core";
import { version } from "../package.json";
import { convertFile, inspectFile } from "./api";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: Io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

const USAGE = `Usage:
  cjconv <input>... <output> [options]   convert a 3D city model
  cjconv info <input>... [--json]        show its format, CRS, LoDs and attributes

Several inputs are files of one dataset, combined into the one output (the last
argument). Ids must be unique across them, and they must share a CRS and column types.

Formats: ${FORMAT_IDS.join(", ")}.
The output format comes from the output name (.city.json, .city.jsonl, .fcb, .obj);
an output ending in / is a CityParquet package directory.

Options:
  --to <format>          output format, when the name does not say
  --from <format>        input format, when its name and content do not say
  --lod <list>           LoDs to keep, e.g. 2.2 or 1.2,2.2 (default: all)
  --attributes <list>    attributes to keep (default: all)
  --no-attributes        keep no attributes
  --obj-lod <lod>        the LoD an OBJ input is read as (default: 2.2)
  --crs <EPSG:code>      the CRS of an OBJ input
  --extension <path>     load this cityjson.duckdb_extension instead of the community build
  --force                overwrite an existing output
  --json                 (info) print JSON
  -h, --help             show this help
  -v, --version          show the version
`;

class UsageError extends Error {}

/** "CityJSONSeq", or for a merge "2 inputs (CityJSONSeq)". */
function label(info: SourceInfo): string {
  const fmt = sourceFormat(info.source);
  const name = fmt ? FORMATS[fmt].label : "mixed formats";
  return info.source.kind === "merge" ? `${info.source.sources.length} inputs (${name})` : name;
}

const list = (text: string | undefined) =>
  text === undefined
    ? undefined
    : text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

function format(name: string | undefined, flag: string): FormatId | undefined {
  if (name === undefined) return undefined;
  if (!(FORMAT_IDS as string[]).includes(name)) {
    throw new UsageError(`${flag} ${name}: unknown format. Use one of: ${FORMAT_IDS.join(", ")}.`);
  }
  return name as FormatId;
}

function bytes(path: string): string {
  try {
    const n = statSync(path).size;
    return n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
  } catch {
    return "?";
  }
}

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        to: { type: "string" },
        from: { type: "string" },
        lod: { type: "string" },
        attributes: { type: "string" },
        "no-attributes": { type: "boolean" },
        "obj-lod": { type: "string" },
        crs: { type: "string" },
        extension: { type: "string" },
        force: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    io.stderr(`cjconv: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  const { values: o, positionals } = args;

  if (o.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (o.version) {
    io.stdout(`${version}\n`);
    return 0;
  }

  try {
    if (o.attributes !== undefined && o["no-attributes"]) {
      throw new UsageError("--attributes and --no-attributes contradict each other.");
    }
    const source = {
      from: format(o.from, "--from"),
      obj: { lod: o["obj-lod"], crs: o.crs },
      extensionPath: o.extension,
    };

    if (positionals[0] === "info") {
      const inputs = positionals.slice(1);
      if (inputs.length === 0) throw new UsageError("info takes an input.");
      const info = await inspectFile(inputs, source);
      const fmt = sourceFormat(info.source);
      const crs = info.crs ? crsToAuthCode(info.crs) : null;
      if (o.json) {
        io.stdout(
          `${JSON.stringify(
            {
              format: fmt ?? "mixed",
              ...(inputs.length > 1 ? { inputs } : {}),
              crs,
              objects: info.objects ?? null,
              lods: info.schema.lods,
              attributes: info.schema.attributes,
              tables: info.tables,
            },
            null,
            2,
          )}\n`,
        );
        return 0;
      }
      const attrs = info.schema.attributes.map((a) => a.name);
      io.stdout(
        [
          inputs.length > 1 ? `${inputs.length} inputs: ${inputs.join(", ")}` : inputs[0],
          `  format      ${label(info)}`,
          `  CRS         ${crs ?? "none"}`,
          `  objects     ${info.objects ?? "unknown"}`,
          `  LoDs        ${info.schema.lods.join(", ") || "none"}`,
          ...(info.tables.length ? [`  tables      ${info.tables.join(", ")}`] : []),
          `  attributes  ${attrs.length}${attrs.length ? `: ${attrs.join(", ")}` : ""}`,
          "",
        ].join("\n"),
      );
      return 0;
    }

    if (positionals.length < 2) {
      throw new UsageError(
        positionals.length === 0
          ? "Give an input and an output."
          : "Give an output after the input.",
      );
    }
    const inputs = positionals.slice(0, -1);
    const output = positionals.at(-1)!;
    const result = await convertFile({
      ...source,
      input: inputs,
      output,
      to: format(o.to, "--to"),
      lods: list(o.lod),
      attributes: o["no-attributes"] ? [] : list(o.attributes),
      force: o.force,
    });
    io.stdout(
      `${label(result.source)} → ${FORMATS[result.target].label}\n` +
        result.files.map((f) => `  wrote ${f} (${bytes(f)})\n`).join(""),
    );
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`cjconv: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`cjconv: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
