import type { ConnectionConfig, QueryResult } from "../types";
import type { DbClient } from "./client";
import type { OptionalModuleLoader } from "./factory";

type SqliteDatabase = {
  all(sql: string, params?: unknown[], cb?: (err: Error | null, rows: unknown[]) => void): void;
  close(cb?: (err?: Error | null) => void): void;
};

export class SqliteClient implements DbClient {
  public readonly config: ConnectionConfig;
  private db: SqliteDatabase | null = null;
  private sqlite3: any;
  private readonly loader?: OptionalModuleLoader;

  public constructor(config: ConnectionConfig, loader?: OptionalModuleLoader) {
    this.config = config;
    this.loader = loader;
  }

  public get isConnected(): boolean {
    return this.db !== null;
  }

  public async connect(_password: string): Promise<void> {
    if (this.db) return;
    const file = this.config.sqliteFilePath ?? this.config.host;
    if (!file?.trim()) throw new Error("SQLite file path is required.");

    try {
      this.sqlite3 = this.loader ? this.loader.require("sqlite3") : optionalRequire("sqlite3");
    } catch {
      throw new Error("Missing driver: sqlite3");
    }

    const Database = this.sqlite3.Database as new (
      filename: string,
      cb: (err?: Error | null) => void
    ) => SqliteDatabase;
    this.db = await new Promise<SqliteDatabase>((resolve, reject) => {
      const instance = new Database(file, (err) => (err ? reject(err) : resolve(instance)));
    });
  }

  public async disconnect(): Promise<void> {
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    await new Promise<void>((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
  }

  public async query(sql: string): Promise<QueryResult> {
    if (!this.db) throw new Error("Not connected");
    const start = Date.now();
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      this.db!.all(sql, [], (err, r) => (err ? reject(err) : resolve(r ?? [])));
    });
    const durationMs = Date.now() - start;
    const normalizedRows: Array<Record<string, unknown>> = Array.isArray(rows)
      ? (rows as Array<Record<string, unknown>>)
      : [];
    const columns = normalizedRows.length > 0 ? Object.keys(normalizedRows[0] ?? {}) : [];
    return { columns, rows: normalizedRows, rowCount: normalizedRows.length, durationMs };
  }

  public async listDatabases(): Promise<string[]> {
    const file = this.config.sqliteFilePath ?? this.config.host;
    return [file ?? "sqlite"];
  }

  public async listTables(_database: string): Promise<Array<{ name: string; schema?: string; type?: string }>> {
    const res = await this.query(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name;"
    );
    return (res.rows ?? []).map((r) => ({
      name: String(r["name"] ?? ""),
      type: String(r["type"] ?? "")
    }));
  }
}

function optionalRequire(id: string): any {
  // Keep optional native deps out of the esbuild bundle.
  // eslint-disable-next-line no-eval
  const req = (0, eval)("require") as (s: string) => any;
  return req(id);
}
