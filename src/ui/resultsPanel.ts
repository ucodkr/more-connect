import * as vscode from "vscode";
import type { ConnectionConfig, QueryResult } from "../types";

export class ResultsPanel {
  private panel: vscode.WebviewPanel | undefined;

  public constructor(private readonly ctx: vscode.ExtensionContext) {}

  public show(connection: ConnectionConfig, sql: string, result: QueryResult): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "moreConnect.results",
        "More Connect: Results",
        vscode.ViewColumn.Two,
        { enableScripts: false }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.title = `Results: ${connection.name}`;
    this.panel.webview.html = renderHtml(connection, sql, result);
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(connection: ConnectionConfig, sql: string, result: QueryResult): string {
  const maxRows = 200;
  const rows = result.rows.slice(0, maxRows);
  const columns = result.columns.length ? result.columns : inferColumns(rows);

  const headerCells = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const bodyRows = rows
    .map((r) => {
      const tds = columns
        .map((c) => {
          const v = r[c];
          const text =
            v === null || v === undefined
              ? ""
              : typeof v === "object"
                ? JSON.stringify(v)
                : String(v);
          return `<td title="${escapeHtml(text)}">${escapeHtml(text)}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  const subtitle = `${connection.type}@${connection.host}:${connection.port}${connection.database ? `/${connection.database}` : ""}`;
  const meta = `rows=${result.rowCount ?? result.rows.length}, duration=${result.durationMs}ms`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; padding: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
      .meta { opacity: 0.8; margin-bottom: 10px; }
      pre { white-space: pre-wrap; word-break: break-word; background: rgba(127,127,127,.12); padding: 10px; border-radius: 6px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid rgba(127,127,127,.35); padding: 6px 8px; vertical-align: top; }
      th { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); text-align: left; }
      td { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
      .note { margin-top: 10px; opacity: .75; }
    </style>
  </head>
  <body>
    <div class="meta"><strong>${escapeHtml(connection.name)}</strong> — ${escapeHtml(subtitle)} — ${escapeHtml(meta)}</div>
    <pre>${escapeHtml(sql)}</pre>
    <table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <div class="note">${result.rows.length > maxRows ? `Showing first ${maxRows} rows.` : ""}</div>
  </body>
</html>`;
}

function inferColumns(rows: Array<Record<string, unknown>>): string[] {
  return rows.length ? Object.keys(rows[0] ?? {}) : [];
}
