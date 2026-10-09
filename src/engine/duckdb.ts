// duckdb-wasm implementation of core's Engine, plus the browser-side file I/O that
// core deliberately knows nothing about.
import * as duckdb from "@duckdb/duckdb-wasm";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import type { Engine, Row } from "@/core/engine";

export interface BrowserEngine extends Engine {
  /** Makes bytes readable by SQL under `path`. The buffer is transferred to the worker. */
  registerFile(path: string, bytes: Uint8Array): Promise<void>;
  /** Reads a file the extension wrote. */
  readFile(path: string): Promise<Uint8Array>;
  /** Frees virtual-FS files (inputs and outputs) once they are no longer needed. */
  dropFiles(paths: string[]): Promise<void>;
  /** Tears the worker down; create a new engine afterwards (e.g. after an OOM). */
  terminate(): Promise<void>;
}

/**
 * Extensions are vendored under public/duckdb-ext/<duckdb>/<platform>/ (see
 * scripts/vendor-extensions.mjs), never fetched from the community CDN at runtime.
 */
const EXTENSION_REPOSITORY = new URL(`${import.meta.env.BASE_URL}duckdb-ext`, location.href).href;

/** Arrow rows → plain JSON values: BIGINT becomes number, STRUCT/LIST plain objects/arrays. */
function toRows(table: { toArray(): { toJSON(): unknown }[] }): Row[] {
  return table
    .toArray()
    .map(
      (row) =>
        JSON.parse(
          JSON.stringify(row.toJSON(), (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v)),
        ) as Row,
    );
}

export async function createBrowserEngine(): Promise<BrowserEngine> {
  const worker = new Worker(ehWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(ehWasm);
  // The vendored cityjson build is self-built from duckdb-cityjson (until the community
  // repository publishes a fixed one), so it is unsigned. The app only ever LOADs from
  // its own origin (custom_extension_repository below) and runs no user-written SQL.
  await db.open({ allowUnsignedExtensions: true });
  const conn = await db.connect();

  await conn.query(`SET custom_extension_repository = '${EXTENSION_REPOSITORY}'`);
  await conn.query("LOAD cityjson");
  // cityparquet_* write and read Parquet; autoloading can't reach the default
  // repository once a custom one is set, so load it explicitly.
  await conn.query("LOAD parquet");

  return {
    async query(sql) {
      return toRows(await conn.query(sql));
    },
    async exec(sql) {
      await conn.query(sql);
    },
    async registerFile(path, bytes) {
      await db.registerFileBuffer(path, bytes);
    },
    async readFile(path) {
      return db.copyFileToBuffer(path);
    },
    async dropFiles(paths) {
      for (const path of paths) {
        try {
          await db.dropFile(path);
        } catch {
          // Already gone; nothing to free.
        }
      }
    },
    async terminate() {
      await conn.close().catch(() => undefined);
      await db.terminate();
    },
  };
}
