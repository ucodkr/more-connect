import type { ConnectionConfig } from "../types";
import type { DbClient } from "./client";
import { MysqlClient } from "./mysqlClient";
import { PostgresClient } from "./postgresClient";

export function createClient(config: ConnectionConfig): DbClient {
  switch (config.type) {
    case "mysql":
    case "mariadb":
      return new MysqlClient(config);
    case "postgres":
      return new PostgresClient(config);
    default: {
      const exhaustive: never = config.type;
      throw new Error(`Unsupported DB type: ${exhaustive}`);
    }
  }
}

