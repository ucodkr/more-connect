import type { ConnectionConfig, QueryResult } from "../types";

export interface DbClient {
  readonly config: ConnectionConfig;
  readonly isConnected: boolean;
  connect(password: string): Promise<void>;
  disconnect(): Promise<void>;
  query(sql: string): Promise<QueryResult>;
  listDatabases(): Promise<string[]>;
  listTables(database: string): Promise<Array<{ name: string; schema?: string; type?: string }>>;
}
