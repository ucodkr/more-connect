import type { ConnectionConfig } from "../types";
import type { DbClient } from "./client";
import { MysqlClient } from "./mysqlClient";
import { PostgresClient } from "./postgresClient";
import { SqliteClient } from "./sqliteClient";
import { OracleClient } from "./oracleClient";
import { RedisClient } from "./redisClient";

export type OptionalModuleLoader = {
  require(id: string): any;
};

export function createClient(config: ConnectionConfig, loader?: OptionalModuleLoader): DbClient {
  switch (config.type) {
    case "mysql":
    case "mariadb":
      return new MysqlClient(config);
    case "postgres":
      return new PostgresClient(config);
    case "sqlite":
      return new SqliteClient(config, loader);
    case "oracle":
      return new OracleClient(config, loader);
    case "redis":
      return new RedisClient(config);
    default: {
      const exhaustive: never = config.type;
      throw new Error(`Unsupported DB type: ${exhaustive}`);
    }
  }
}
