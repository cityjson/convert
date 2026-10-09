// A native DuckDB Engine for integration tests: same SQL, same extension, no wasm.
import { DuckDBInstance } from "@duckdb/node-api";
import type { Engine, Row } from "../../src/core/engine";

export interface NodeEngine extends Engine {
  close(): void;
}

export async function createNodeEngine(): Promise<NodeEngine> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL cityjson FROM community");
  await conn.run("LOAD cityjson");
  return {
    async query(sql: string): Promise<Row[]> {
      const reader = await conn.runAndReadAll(sql);
      return reader.getRowObjectsJson() as Row[];
    },
    async exec(sql: string): Promise<void> {
      await conn.run(sql);
    },
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}
