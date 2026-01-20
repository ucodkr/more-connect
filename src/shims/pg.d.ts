declare module "pg" {
  export type FieldDef = { name: string };

  export type QueryResult<R extends Record<string, unknown> = Record<string, unknown>> = {
    rows: R[];
    rowCount?: number | null;
    fields?: FieldDef[];
  };

  export class Client {
    constructor(config: {
      host?: string;
      port?: number;
      user?: string;
      password?: string;
      database?: string;
      ssl?: boolean | { rejectUnauthorized?: boolean };
    });
    connect(): Promise<void>;
    end(): Promise<void>;
    query<R extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<QueryResult<R>>;
  }

  const pg: { Client: typeof Client };
  export default pg;
}

