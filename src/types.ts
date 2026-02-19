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
  oraclePrivilege?: "default" | "sysdba" | "sysoper";
  redisDatabase?: number;
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPrivateKeyPath?: string;
  sshRemoteHost?: string;
  sshRemotePort?: number;
};

export type SshConnection = {
  id: string;
  name: string;
  /** Preferred SSH target (usually Host alias from ~/.ssh/config). */
  target: string;
  /** Optional metadata used for display/editing. */
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
};

export type WebLink = {
  id: string;
  name: string;
  url: string;
};

export type OllamaEndpoint = {
  id: string;
  name: string;
  url: string;
};

export type QueryResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
  durationMs: number;
};
