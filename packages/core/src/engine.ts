// The one seam between core and a DuckDB runtime. Core only ever sends SQL; getting
// bytes in and out (file registration, downloads) is the runtime adapter's job.

/** A result row with JSON-compatible values (BIGINT as number, STRUCT as object). */
export type Row = Record<string, unknown>;

export interface Engine {
  /** Runs one statement and returns its rows. */
  query(sql: string): Promise<Row[]>;
  /**
   * Runs one statement and discards the result. Callers send PRAGMAs one per call:
   * DuckDB expands every pragma in a batch before running any of it.
   */
  exec(sql: string): Promise<void>;
}
