import * as vscode from "vscode";
import type { DbClient } from "../db/client";
import type { DbType } from "../types";

export function quoteIdentPg(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteIdentMysql(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

export function quoteIdentOracle(name: string): string {
  const cleaned = name.replaceAll(/[\u0000-\u001F\u007F\u00A0\u200B-\u200D\uFEFF]/g, "").trim();
  return `"${cleaned.replaceAll('"', '""')}"`;
}

export function quoteStringPg(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteStringMysql(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

export function buildSelectPreviewSql(type: DbType, database: string, table: string, schema?: string): string {
  if (type === "postgres") {
    const qTable = schema ? `${quoteIdentPg(schema)}.${quoteIdentPg(table)}` : quoteIdentPg(table);
    return `SELECT * FROM ${qTable} LIMIT 200;`;
  }
  if (type === "sqlite") {
    return `SELECT * FROM ${quoteIdentPg(table)} LIMIT 200;`;
  }
  if (type === "oracle") {
    const owner = (schema ?? database ?? "").trim();
    const qTable = owner ? `${quoteIdentOracle(owner)}.${quoteIdentOracle(table)}` : quoteIdentOracle(table);
    return `SELECT * FROM ${qTable} WHERE ROWNUM <= 200`;
  }
  const qDb = quoteIdentMysql(database);
  const qTable = quoteIdentMysql(table);
  return `SELECT * FROM ${qDb}.${qTable} LIMIT 200;`;
}

export function renderTable(headers: string[], rows: string[][]): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function escapeRedisArg(s: string): string {
  if (!s.includes(" ") && !s.includes("\t") && !s.includes("\n") && !s.includes('"')) return s;
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function sqlStatementAtCursor(doc: vscode.TextDocument, pos: vscode.Position): string {
  const text = doc.getText();
  if (!text.trim()) return "";
  const offset = doc.offsetAt(pos);
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const before = text.lastIndexOf(";", Math.max(0, safeOffset - 1));
  const start = before === -1 ? 0 : before + 1;
  const after = text.indexOf(";", safeOffset);
  const end = after === -1 ? text.length : after;
  return text.slice(start, end).trim();
}

export function safeJsonParseArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function fetchMysqlCreateTable(client: DbClient, database: string, table: string): Promise<string> {
  const sql = `SHOW CREATE TABLE ${quoteIdentMysql(database)}.${quoteIdentMysql(table)};`;
  const result = await client.query(sql);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const create =
    (row?.["Create Table"] as string | undefined) ??
    (Object.values(row ?? {}).find((value) => typeof value === "string" && String(value).includes("CREATE TABLE")) as
      | string
      | undefined);
  if (!create) throw new Error("Could not read CREATE TABLE output.");
  return create.endsWith(";") ? create : `${create};`;
}

export async function buildPostgresTableDdl(client: DbClient, schema: string, table: string): Promise<string> {
  const columnsSql = `SELECT column_name, data_type, is_nullable, column_default, udt_name, character_maximum_length, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = ${quoteStringPg(schema)} AND table_name = ${quoteStringPg(table)}
ORDER BY ordinal_position;`;

  const pkSql = `SELECT kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = ${quoteStringPg(schema)}
  AND tc.table_name = ${quoteStringPg(table)}
  AND tc.constraint_type = 'PRIMARY KEY'
ORDER BY kcu.ordinal_position;`;

  const uniquesSql = `SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = ${quoteStringPg(schema)}
  AND tc.table_name = ${quoteStringPg(table)}
  AND tc.constraint_type = 'UNIQUE'
ORDER BY tc.constraint_name, kcu.ordinal_position;`;

  const fksSql = `SELECT tc.constraint_name,
       kcu.column_name,
       ccu.table_schema AS foreign_table_schema,
       ccu.table_name AS foreign_table_name,
       ccu.column_name AS foreign_column_name,
       kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.table_schema = tc.table_schema
WHERE tc.table_schema = ${quoteStringPg(schema)}
  AND tc.table_name = ${quoteStringPg(table)}
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.constraint_name, kcu.ordinal_position;`;

  const [columnsRes, pkRes, uniqRes, fkRes] = await Promise.all([
    client.query(columnsSql),
    client.query(pkSql),
    client.query(uniquesSql),
    client.query(fksSql)
  ]);

  const columns = columnsRes.rows as Array<Record<string, unknown>>;
  if (columns.length === 0) throw new Error("Table not found (no columns).");

  const pkCols = (pkRes.rows as Array<Record<string, unknown>>).map((r) => String(r["column_name"] ?? ""));
  const uniquesRows = uniqRes.rows as Array<Record<string, unknown>>;
  const uniqueByName = new Map<string, Array<{ col: string; pos: number }>>();
  for (const row of uniquesRows) {
    const name = String(row["constraint_name"] ?? "");
    const col = String(row["column_name"] ?? "");
    const pos = Number(row["ordinal_position"] ?? 0);
    const items = uniqueByName.get(name) ?? [];
    items.push({ col, pos });
    uniqueByName.set(name, items);
  }

  const fkRows = fkRes.rows as Array<Record<string, unknown>>;
  const fkByName = new Map<string, Array<{ col: string; pos: number; refSchema: string; refTable: string; refCol: string }>>();
  for (const row of fkRows) {
    const name = String(row["constraint_name"] ?? "");
    const col = String(row["column_name"] ?? "");
    const pos = Number(row["ordinal_position"] ?? 0);
    const refSchema = String(row["foreign_table_schema"] ?? "");
    const refTable = String(row["foreign_table_name"] ?? "");
    const refCol = String(row["foreign_column_name"] ?? "");
    const items = fkByName.get(name) ?? [];
    items.push({ col, pos, refSchema, refTable, refCol });
    fkByName.set(name, items);
  }

  const lines: string[] = [];
  lines.push(`CREATE TABLE ${quoteIdentPg(schema)}.${quoteIdentPg(table)} (`);

  const colLines = columns.map((column) => {
    const name = String(column["column_name"] ?? "");
    const dataType = String(column["data_type"] ?? "");
    const udt = String(column["udt_name"] ?? "");
    const charLen = column["character_maximum_length"];
    const numPrec = column["numeric_precision"];
    const numScale = column["numeric_scale"];

    let typeSql = dataType;
    if (dataType === "character varying" && typeof charLen === "number") typeSql = `varchar(${charLen})`;
    if (dataType === "character" && typeof charLen === "number") typeSql = `char(${charLen})`;
    if (dataType === "numeric" && typeof numPrec === "number") {
      typeSql = typeof numScale === "number" ? `numeric(${numPrec},${numScale})` : `numeric(${numPrec})`;
    }
    if (dataType === "USER-DEFINED" && udt) typeSql = udt;

    const nullable = String(column["is_nullable"] ?? "YES") === "NO" ? " NOT NULL" : "";
    const def = column["column_default"];
    const defSql = def ? ` DEFAULT ${String(def)}` : "";
    return `  ${quoteIdentPg(name)} ${typeSql}${defSql}${nullable}`;
  });

  const constraintLines: string[] = [];
  if (pkCols.length) {
    constraintLines.push(`  PRIMARY KEY (${pkCols.map(quoteIdentPg).join(", ")})`);
  }
  for (const [name, cols] of uniqueByName.entries()) {
    const sorted = [...cols].sort((a, b) => a.pos - b.pos).map((item) => quoteIdentPg(item.col)).join(", ");
    if (sorted) constraintLines.push(`  CONSTRAINT ${quoteIdentPg(name)} UNIQUE (${sorted})`);
  }
  for (const [name, cols] of fkByName.entries()) {
    const sorted = [...cols].sort((a, b) => a.pos - b.pos);
    const localCols = sorted.map((item) => quoteIdentPg(item.col)).join(", ");
    const ref = sorted[0];
    const refCols = sorted.map((item) => quoteIdentPg(item.refCol)).join(", ");
    if (localCols && ref?.refTable) {
      constraintLines.push(
        `  CONSTRAINT ${quoteIdentPg(name)} FOREIGN KEY (${localCols}) REFERENCES ${quoteIdentPg(ref.refSchema)}.${quoteIdentPg(ref.refTable)} (${refCols})`
      );
    }
  }

  const allInner = [...colLines, ...constraintLines].map((line, index, items) => (index === items.length - 1 ? line : `${line},`));
  lines.push(...allInner);
  lines.push(");");
  return lines.join("\n");
}
