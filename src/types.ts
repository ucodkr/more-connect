export type DbType = "mysql" | "mariadb" | "postgres" | "sqlite" | "oracle" | "redis";

export type ConnectionConfig = {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  user: string;
  database?: string;
  ssl?: boolean;
  sqliteFilePath?: string;
  oracleConnectString?: string;
  redisDatabase?: number;
};

export type QueryResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
  durationMs: number;
};
