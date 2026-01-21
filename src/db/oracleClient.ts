import type { ConnectionConfig, QueryResult } from "../types";
import type { DbClient } from "./client";
import type { OptionalModuleLoader } from "./factory";

type OracleConnection = {
  execute(
    sql: string,
    binds?: any,
    options?: any
  ): Promise<{ metaData?: Array<{ name: string }>; rows?: unknown[]; rowsAffected?: number }>;
  close(): Promise<void>;
};

export class OracleClient implements DbClient {
  public readonly config: ConnectionConfig;
  private conn: OracleConnection | null = null;
  private oracledb: any;
  private readonly loader?: OptionalModuleLoader;

  public constructor(config: ConnectionConfig, loader?: OptionalModuleLoader) {
    this.config = config;
    this.loader = loader;
  }

  public get isConnected(): boolean {
    return this.conn !== null;
  }

  public async connect(password: string): Promise<void> {
    if (this.conn) return;
    const connectString = this.config.oracleConnectString ?? this.config.host;
    if (!connectString?.trim()) throw new Error("Oracle connect string is required.");

    // Optional dependency: users must install `oracledb` into the extension's globalStorage driver dir.
    // Note: node-oracledb can run in Thin mode without Oracle Instant Client.
    try {
      this.oracledb = this.loader ? this.loader.require("oracledb") : optionalRequire("oracledb");
    } catch {
      throw new Error("Missing driver: oracledb");
    }

    const connection: OracleConnection = await this.oracledb.getConnection({
      user: this.config.user,
      password,
      connectString,
      ...(this.config.oraclePrivilege === "sysdba"
        ? { privilege: this.oracledb.SYSDBA }
        : this.config.oraclePrivilege === "sysoper"
          ? { privilege: this.oracledb.SYSOPER }
          : {})
    });
    this.conn = connection;
  }

  public async disconnect(): Promise<void> {
    if (!this.conn) return;
    const c = this.conn;
    this.conn = null;
    await c.close();
  }

  public async query(sql: string): Promise<QueryResult> {
    if (!this.conn) throw new Error("Not connected");
    const start = Date.now();
    const res = await this.conn.execute(stripTrailingSemicolon(sql), [], {
      outFormat: this.oracledb?.OUT_FORMAT_OBJECT
    });
    const durationMs = Date.now() - start;
    const rows = (res.rows ?? []) as Array<Record<string, unknown>>;
    const columns = (res.metaData ?? []).map((m) => m.name);
    return { columns, rows, rowCount: res.rowsAffected ?? rows.length, durationMs };
  }

  public async listDatabases(): Promise<string[]> {
    // Oracle doesn't have "databases" like MySQL/Postgres; treat schemas as databases.
    const res = await this.query("SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME");
    return (res.rows ?? []).map((r) => String(r["USERNAME"] ?? r["username"] ?? "")).filter((s) => s.length > 0);
  }

  public async listTables(database: string): Promise<Array<{ name: string; schema?: string; type?: string }>> {
    const owner = (database || this.config.user || "").toUpperCase();
    const res = await this.query(
      `SELECT OWNER as table_schema, TABLE_NAME as table_name, 'TABLE' as table_type FROM ALL_TABLES WHERE OWNER = '${owner.replaceAll("'", "''")}' ORDER BY TABLE_NAME`
    );
    return (res.rows ?? []).map((r) => ({
      name: String(r["TABLE_NAME"] ?? r["table_name"] ?? ""),
      schema: String(r["OWNER"] ?? r["table_schema"] ?? owner),
      type: String(r["table_type"] ?? "TABLE")
    }));
  }
}

function optionalRequire(id: string): any {
  // Keep optional native deps out of the esbuild bundle.
  // eslint-disable-next-line no-eval
  const req = (0, eval)("require") as (s: string) => any;
  return req(id);
}

function stripTrailingSemicolon(sql: string): string {
  let s = sql.trim();
  while (s.endsWith(";")) s = s.slice(0, -1).trimEnd();
  return s;
}
