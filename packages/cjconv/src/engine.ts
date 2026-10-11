// A native DuckDB Engine (@duckdb/node-api) with the cityjson extension loaded.
import { DuckDBInstance } from "@duckdb/node-api";
import type { Engine, Row } from "@cityjson/cjconv-core";

export interface NodeEngineOptions {
  /**
   * A local `cityjson.duckdb_extension` to load instead of the community build, e.g. one
   * built from duckdb-cityjson's develop branch. It must match this DuckDB's version.
   */
  extensionPath?: string;
}

export interface NodeEngine extends Engine {
  /** Whether a function exists, e.g. `read_obj`, which older extension builds lack. */
  hasFunction(name: string): Promise<boolean>;
  close(): void;
}

export async function createNodeEngine(options: NodeEngineOptions = {}): Promise<NodeEngine> {
  const instance = await DuckDBInstance.create(
    ":memory:",
    options.extensionPath ? { allow_unsigned_extensions: "true" } : {},
  );
  const conn = await instance.connect();
  try {
    if (options.extensionPath) {
      await conn.run(`LOAD '${options.extensionPath.replaceAll("'", "''")}'`);
    } else {
      await conn.run("INSTALL cityjson FROM community");
      await conn.run("LOAD cityjson");
    }
  } catch (e) {
    conn.closeSync();
    instance.closeSync();
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      options.extensionPath
        ? `Could not load the cityjson extension from ${options.extensionPath}: ${reason}`
        : `Could not install the cityjson DuckDB extension (first use needs network access): ${reason}`,
    );
  }

  // Rows as plain JSON, as core's Engine contract (and the web engine) has them: BIGINT
  // as number, STRUCT/LIST as objects/arrays. getRowObjectsJson would give BIGINT as text.
  const query = async (sql: string): Promise<Row[]> => {
    const reader = await conn.runAndReadAll(sql);
    return JSON.parse(
      JSON.stringify(reader.getRowObjectsJS(), (_, v: unknown) =>
        typeof v === "bigint" ? Number(v) : v,
      ),
    ) as Row[];
  };

  return {
    query,
    async exec(sql: string): Promise<void> {
      await conn.run(sql);
    },
    async hasFunction(name: string): Promise<boolean> {
      const rows = await query(
        `SELECT 1 FROM duckdb_functions() WHERE function_name = '${name.replaceAll("'", "''")}' LIMIT 1`,
      );
      return rows.length > 0;
    },
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}
