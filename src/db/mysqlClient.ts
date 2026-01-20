import type { ConnectionConfig, QueryResult } from "../types";
import type { DbClient } from "./client";
import mysql from "mysql2/promise";

export class MysqlClient implements DbClient {
  public readonly config: ConnectionConfig;
  private conn: mysql.Connection | null = null;

  public constructor(config: ConnectionConfig) {
    this.config = config;
  }

  public get isConnected(): boolean {
    return this.conn !== null;
  }

  public async connect(password: string): Promise<void> {
    if (this.conn) return;
    this.conn = await mysql.createConnection({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password,
      database: this.config.database,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined
    });
  }

  public async disconnect(): Promise<void> {
    if (!this.conn) return;
    const c = this.conn;
    this.conn = null;
    await c.end();
  }

  public async query(sql: string): Promise<QueryResult> {
    if (!this.conn) throw new Error("Not connected");
    const start = Date.now();
    const [rows, fields] = await this.conn.query(sql);
    const durationMs = Date.now() - start;

    const normalizedRows: Array<Record<string, unknown>> = Array.isArray(rows)
      ? (rows as Array<Record<string, unknown>>)
      : [];
    const columns =
      Array.isArray(fields) && fields.length > 0
        ? fields.map((f) => f.name)
        : normalizedRows.length > 0
          ? Object.keys(normalizedRows[0] ?? {})
          : [];

    return {
      columns,
      rows: normalizedRows,
      rowCount: normalizedRows.length,
      durationMs
    };
  }

  public async listDatabases(): Promise<string[]> {
    if (!this.conn) throw new Error("Not connected");
    const [rows] = await this.conn.query("SHOW DATABASES");
    const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    return list
      .map((r) => {
        const firstKey = Object.keys(r)[0];
        const v = firstKey ? r[firstKey] : undefined;
        return typeof v === "string" ? v : String(v ?? "");
      })
      .filter((s) => s.length > 0);
  }

  public async listTables(database: string): Promise<Array<{ name: string; schema?: string; type?: string }>> {
    if (!this.conn) throw new Error("Not connected");
    const safeDb = escapeMysqlIdent(database);
    const [rows] = await this.conn.query(`SHOW FULL TABLES FROM ${safeDb}`);
    const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    return list
      .map((r) => {
        const keys = Object.keys(r);
        const nameKey = keys.find((k) => k.toLowerCase().startsWith("tables_in_")) ?? keys[0];
        const typeKey = keys.find((k) => k.toLowerCase() === "table_type");
        const nameVal = nameKey ? r[nameKey] : undefined;
        const typeVal = typeKey ? r[typeKey] : undefined;
        const name = typeof nameVal === "string" ? nameVal : String(nameVal ?? "");
        const type = typeof typeVal === "string" ? typeVal : typeVal ? String(typeVal) : undefined;
        return name ? { name, type } : null;
      })
      .filter((x): x is { name: string; schema?: string; type?: string } => x !== null);
  }
}

function escapeMysqlIdent(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}
