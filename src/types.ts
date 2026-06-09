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
  /** Remote folders shown under this connection in the SSH tree. */
  folders?: string[];
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

export type DockerHost = {
  id: string;
  name: string;
  host: string;
};

export type LlmProvider = "ollama" | "vllm";

export type OllamaEndpoint = {
  id: string;
  name: string;
  url: string;
  provider?: LlmProvider;
};

export type VsCodeFavorite = {
  id: string;
  name: string;
  targetPath: string;
  kind: "folder" | "workspace" | "remoteSsh";
};

export type S3Provider = "aws" | "minio" | "s3compatible";

export type S3Host = {
  id: string;
  name: string;
  provider: S3Provider;
  /** e.g. https://s3.amazonaws.com or http://localhost:9000 (MinIO) */
  endpointUrl?: string;
  /** e.g. us-east-1 */
  region: string;
  accessKeyId: string;
  /** Needed for most S3-compatible services (MinIO, etc.) */
  forcePathStyle?: boolean;
};

export type QueryResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
  durationMs: number;
};
