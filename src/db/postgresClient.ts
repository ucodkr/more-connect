import type { ConnectionConfig, QueryResult } from "../types";
import type { DbClient } from "./client";
import * as pg from "pg";

export class PostgresClient implements DbClient {
  public readonly config: ConnectionConfig;
  private client: pg.Client | null = null;

  public constructor(config: ConnectionConfig) {
    this.config = config;
  }

  public get isConnected(): boolean {
    return this.client !== null;
  }

  public async connect(password: string): Promise<void> {
    if (this.client) return;
    const client = new pg.Client({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password,
      database: this.config.database,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined
    });
    await client.connect();
    this.client = client;
  }

  public async disconnect(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    await c.end();
  }

  public async query(sql: string): Promise<QueryResult> {
    if (!this.client) throw new Error("Not connected");
    const start = Date.now();
    const res = await this.client.query(sql);
    const durationMs = Date.now() - start;
    const columns = (res.fields ?? []).map((f: pg.FieldDef) => f.name);
    return {
      columns,
      rows: (res.rows ?? []) as Array<Record<string, unknown>>,
      rowCount: res.rowCount ?? undefined,
      durationMs
    };
  }

  public async listDatabases(): Promise<string[]> {
    if (!this.client) throw new Error("Not connected");
    const res = await this.client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
    );
    return (res.rows ?? []).map((r) => r.datname).filter((s) => typeof s === "string" && s.length > 0);
  }

  public async listTables(database: string): Promise<Array<{ name: string; schema?: string; type?: string }>> {
    if (!this.client) throw new Error("Not connected");
    const current = await this.client.query<{ db: string }>("SELECT current_database() AS db");
    const currentDb = current.rows?.[0]?.db;
    if (currentDb && database !== currentDb) {
      throw new Error("Switching database requires a separate connection (not implemented here).");
    }
    const res = await this.client.query<{ table_schema: string; table_name: string; table_type: string }>(
      "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name"
    );
    return (res.rows ?? []).map((r) => ({
      name: r.table_name,
      schema: r.table_schema,
      type: r.table_type
    }));
  }
}
