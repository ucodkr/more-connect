import * as vscode from "vscode";
import type { ConnectionConfig, QueryResult } from "../types";

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
    this.panel.webview.html = renderHtml(connection, sql, result);
  }

  public postMessage(message: any): void {
    try {
      this.panel?.webview.postMessage(message);
    } catch {}
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

  const rowIdColumn = findRowIdColumn(columns);
  const editable = connection.type === "oracle" && Boolean(rowIdColumn) && Boolean(parseSingleFromTable(sql));
  const fromTable = parseSingleFromTable(sql);

  const headerCells = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const bodyRows = rows
    .map((r, rowIndex) => {
      const tds = columns
        .map((c, colIndex) => {
          const v = r[c];
          const text =
            v === null || v === undefined
              ? ""
              : typeof v === "object"
                ? JSON.stringify(v)
                : String(v);
          const baseAttrs = `data-row="${rowIndex}" data-col="${colIndex}" data-colname="${escapeHtml(c)}"`;
          const rowId = rowIdColumn ? r[rowIdColumn] : undefined;
          const rowIdAttr = rowId === null || rowId === undefined ? "" : ` data-rowid="${escapeHtml(String(rowId))}"`;
          const editableAttr =
            editable && c !== rowIdColumn ? ` contenteditable="true" spellcheck="false"` : "";
          return `<td ${baseAttrs}${rowIdAttr}${editableAttr} title="${escapeHtml(text)}">${escapeHtml(text)}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  const subtitle = `${connection.type}@${connection.host}:${connection.port}${connection.database ? `/${connection.database}` : ""}`;
  const meta = `rows=${result.rowCount ?? result.rows.length}, duration=${result.durationMs}ms`;

  const initPayload = {
    connectionId: connection.id,
    database: connection.database ?? "",
    dbType: connection.type,
    sql,
    table: fromTable ?? "",
    rowIdColumn: rowIdColumn ?? "",
    editable
  };

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
      .actions { display: flex; gap: 8px; align-items: center; margin: 10px 0; }
      button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
      button:disabled { opacity: .5; cursor: default; }
      .status { opacity: .8; }
      td[contenteditable="true"] { outline: 1px dashed rgba(127,127,127,.55); outline-offset: -2px; }
    </style>
  </head>
  <body>
    <div class="meta"><strong>${escapeHtml(connection.name)}</strong> — ${escapeHtml(subtitle)} — ${escapeHtml(meta)}</div>
    <pre>${escapeHtml(sql)}</pre>
    <div class="actions">
      <button id="rerunRowid">Re-run (editable)</button>
      <span class="status" id="status"></span>
    </div>
    <table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <div class="note">${result.rows.length > maxRows ? `Showing first ${maxRows} rows.` : ""}</div>
    <script>
      const vscode = acquireVsCodeApi();
      const state = ${JSON.stringify(initPayload)};
      const statusEl = document.getElementById("status");
      const rerunBtn = document.getElementById("rerunRowid");

      function setStatus(text) { statusEl.textContent = text || ""; }
      function canRerun() { return state.dbType === "oracle" && !!state.table && !state.rowIdColumn; }
      rerunBtn.disabled = !canRerun();
      rerunBtn.title = rerunBtn.disabled ? "Editing requires a single-table SELECT without joins." : "Re-run query with ROWID for editing.";
      rerunBtn.addEventListener("click", () => {
        setStatus("Re-running with ROWID...");
        vscode.postMessage({ type: "results.rerunWithRowid", connectionId: state.connectionId, database: state.database, sql: state.sql });
      });

      if (state.editable) {
        document.addEventListener("blur", async (e) => {
          const cell = e.target;
          if (!cell || cell.tagName !== "TD") return;
          if (!cell.isContentEditable) return;
          const rowid = cell.getAttribute("data-rowid");
          const col = cell.getAttribute("data-colname");
          if (!rowid || !col) return;
          const value = cell.textContent ?? "";
          setStatus("Saving...");
          vscode.postMessage({
            type: "results.updateCell",
            connectionId: state.connectionId,
            database: state.database,
            table: state.table,
            rowid,
            column: col,
            value
          });
        }, true);
      } else {
        setStatus(state.rowIdColumn ? "" : "Tip: click Re-run (editable) to enable editing for simple Oracle SELECTs.");
      }

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "results.status") setStatus(msg.text || "");
      });
    </script>
  </body>
</html>`;
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
