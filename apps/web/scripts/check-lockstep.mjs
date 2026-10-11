#!/usr/bin/env node
// Fails when the pinned @duckdb/duckdb-wasm and the vendored extension binaries
// disagree. duckdb-wasm refuses to LOAD an extension whose footer names a different
// DuckDB version, so a mismatch would only show up at runtime in the browser.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT, extensionPath, footerFields, readManifest, sha256 } from "./duckdb-ext.mjs";

const require = createRequire(path.join(ROOT, "package.json"));
const errors = [];
const manifest = readManifest();

// 1. package.json pins duckdb-wasm exactly, to the version the manifest was made for.
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const pin = pkg.dependencies?.["@duckdb/duckdb-wasm"];
if (pin !== manifest.duckdbWasm) {
  errors.push(
    `package.json pins @duckdb/duckdb-wasm "${pin}", manifest expects "${manifest.duckdbWasm}"`,
  );
}

// 2. The installed duckdb-wasm embeds the DuckDB version the extensions were built for.
const duckdb = require("@duckdb/duckdb-wasm/blocking");
const dist = path.dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"));
const db = await duckdb.createDuckDB(
  {
    eh: { mainModule: path.join(dist, "duckdb-eh.wasm"), mainWorker: "" },
    mvp: { mainModule: path.join(dist, "duckdb-mvp.wasm"), mainWorker: "" },
  },
  new duckdb.VoidLogger(),
  duckdb.NODE_RUNTIME,
);
await db.instantiate();
const version = db.connect().query("PRAGMA version").toArray()[0].toJSON().library_version;
if (version !== manifest.duckdb) {
  errors.push(`@duckdb/duckdb-wasm embeds DuckDB ${version}, manifest expects ${manifest.duckdb}`);
}

// 3. Every vendored binary is present, unmodified, and built for that DuckDB + platform.
for (const [name, ext] of Object.entries(manifest.extensions)) {
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(extensionPath(manifest, name)));
  } catch {
    errors.push(`${name}: missing ${path.relative(ROOT, extensionPath(manifest, name))}`);
    continue;
  }
  if (sha256(bytes) !== ext.sha256) errors.push(`${name}: sha256 differs from manifest`);
  const fields = footerFields(bytes);
  for (const want of [manifest.duckdb, manifest.platform, ...(ext.version ? [ext.version] : [])]) {
    if (!fields.includes(want))
      errors.push(`${name}: footer ${JSON.stringify(fields)} lacks "${want}"`);
  }
}

if (errors.length > 0) {
  console.error(`lockstep check failed:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `lockstep ok: duckdb-wasm ${manifest.duckdbWasm} = DuckDB ${manifest.duckdb}; ` +
    Object.entries(manifest.extensions)
      .map(([n, e]) => `${n}@${e.version ?? manifest.duckdb}`)
      .join(", "),
);
