export type DbType = "mysql" | "mariadb" | "postgres";

export type ConnectionConfig = {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  user: string;
  database?: string;
  ssl?: boolean;
};

export type QueryResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
  durationMs: number;
};

