import * as vscode from "vscode";
import type { ConnectionConfig, QueryResult } from "../types";
import { renderWebviewAppHtml } from "./webviewAppShell";

export class ResultsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private onMessageSub: vscode.Disposable | undefined;

  public constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly onMessage?: (message: any) => void | Promise<void>
  ) {}

  public show(connection: ConnectionConfig, sql: string, result: QueryResult): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "moreConnect.results",
        "More Connect: Results",
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.onMessageSub?.dispose();
        this.onMessageSub = undefined;
      });
      this.onMessageSub = this.panel.webview.onDidReceiveMessage(async (msg) => {
        try {
          await this.onMessage?.(msg);
        } catch {}
      });
    }

    this.panel.title = `Results: ${connection.name}`;
    this.panel.webview.html = renderHtml(this.panel.webview, this.ctx.extensionUri, connection, sql, result);
  }

  public postMessage(message: any): void {
    try {
      this.panel?.webview.postMessage(message);
    } catch {}
  }
}

function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  connection: ConnectionConfig,
  sql: string,
  result: QueryResult
): string {
  const maxRows = 200;
  const rows = result.rows.slice(0, maxRows);
  const columns = result.columns.length ? result.columns : inferColumns(rows);

  const rowIdColumn = findRowIdColumn(columns);
  const editable = connection.type === "oracle" && Boolean(rowIdColumn) && Boolean(parseSingleFromTable(sql));
  const fromTable = parseSingleFromTable(sql);

  const initPayload = {
    connectionId: connection.id,
    connectionName: connection.name,
    subtitle: `${connection.type}@${connection.host}:${connection.port}${connection.database ? `/${connection.database}` : ""}`,
    meta: `rows=${result.rowCount ?? result.rows.length}, duration=${result.durationMs}ms`,
    database: connection.database ?? "",
    dbType: connection.type,
    sql,
    table: fromTable ?? "",
    rowIdColumn: rowIdColumn ?? "",
    editable,
    resultCount: result.rows.length,
    maxRows,
    columns,
    rows
  };
  return renderWebviewAppHtml({
    webview,
    extensionUri,
    title: `Results: ${connection.name}`,
    scriptFile: "resultsApp.js",
    state: initPayload
  });
}

function inferColumns(rows: Array<Record<string, unknown>>): string[] {
  return rows.length ? Object.keys(rows[0] ?? {}) : [];
}

function findRowIdColumn(columns: string[]): string | undefined {
  return columns.find((c) => c.toUpperCase() === "ROWID") ?? columns.find((c) => c === "__MORE_CONNECT_ROWID");
}

function parseSingleFromTable(sql: string): string | undefined {
  const s = sql.replaceAll(/\s+/g, " ").trim().replaceAll(/;+\s*$/g, "");
  const m = s.match(/\bfrom\s+([a-zA-Z0-9_$#."]+)(?:\s+(?:where|order\s+by|group\s+by|fetch|offset|for)\b|$)/i);
  if (!m) return;
  // Reject obvious joins / multiple tables
  if (/\bjoin\b|,/.test(s.toLowerCase())) return;
  return m[1];
}
