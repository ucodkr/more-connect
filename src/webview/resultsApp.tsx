import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { readState as readWebviewState } from "./shared";

type ResultsState = {
  connectionId: string;
  connectionName: string;
  subtitle: string;
  meta: string;
  database: string;
  dbType: string;
  sql: string;
  table: string;
  rowIdColumn: string;
  editable: boolean;
  resultCount: number;
  maxRows: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

type ResultsMessage =
  | { type: "results.runSql"; connectionId: string; database: string; sql: string }
  | { type: "results.rerunWithRowid"; connectionId: string; database: string; sql: string }
  | { type: "results.updateCell"; connectionId: string; database: string; table: string; rowid: string; column: string; value: string };

const styles = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; }
  .page { padding: 12px; }
  .meta { opacity: .8; margin-bottom: 10px; }
  .actions { display: flex; gap: 8px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
  .button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
  .button:disabled { opacity: .5; cursor: default; }
  .status { opacity: .8; }
  .status.error { color: var(--vscode-errorForeground); opacity: 1; }
  .sql { width: 100%; min-height: 110px; resize: vertical; padding: 10px; border-radius: 6px; border: 1px solid rgba(127,127,127,.25); background: rgba(127,127,127,.12); color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .tableWrap { overflow: auto; margin-top: 10px; }
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { border-bottom: 1px solid rgba(127,127,127,.35); padding: 6px 8px; vertical-align: top; text-align: left; }
  .table th { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); }
  .cell { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
  .editable { outline: 1px dashed rgba(127,127,127,.55); outline-offset: -2px; }
  .note { margin-top: 10px; opacity: .75; }
`;

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function App(): React.JSX.Element {
  const vscode = useMemo(() => acquireVsCodeApi(), []);
  const state = useMemo(() => readWebviewState<ResultsState>(), []);
  const [sql, setSql] = useState(state.sql);
  const [status, setStatus] = useState(state.rowIdColumn ? "" : "Tip: click Re-run (editable) to enable editing for simple Oracle SELECTs.");
  const [statusError, setStatusError] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent<{ type?: string; text?: string }>) => {
      if (event.data?.type === "results.status") {
        const next = event.data.text || "";
        setStatus(next);
        setStatusError(/failed|timed out|unknown connection/i.test(next));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const post = (message: ResultsMessage, nextStatus?: string) => {
    if (nextStatus !== undefined) {
      setStatus(nextStatus);
      setStatusError(/failed|timed out|unknown connection/i.test(nextStatus));
    }
    vscode.postMessage(message);
  };

  const runSql = () => {
    if (!sql.trim()) {
      return;
    }
    post({ type: "results.runSql", connectionId: state.connectionId, database: state.database, sql }, "Running...");
  };

  return (
    <>
      <style>{styles}</style>
      <div className="page">
        <div className="meta">
          <strong>{state.connectionName}</strong> - {state.subtitle} - {state.meta}
        </div>
        <div className="actions">
          <button className="button" type="button" onClick={runSql}>Run</button>
          <button
            className="button"
            type="button"
            disabled={state.dbType !== "oracle"}
            title={state.dbType !== "oracle" ? "Re-run (editable) is only supported for Oracle." : "Re-run query with ROWID for editing."}
            onClick={() =>
              post(
                { type: "results.rerunWithRowid", connectionId: state.connectionId, database: state.database, sql },
                "Re-running with ROWID..."
              )
            }
          >
            Re-run (editable)
          </button>
          <span className={`status${statusError ? " error" : ""}`}>{status}</span>
        </div>
        <textarea
          className="sql"
          spellCheck={false}
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              runSql();
            }
          }}
        />
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                {state.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => {
                const rowid = state.rowIdColumn ? row[state.rowIdColumn] : undefined;
                return (
                  <tr key={String(rowid ?? JSON.stringify(row))}>
                    {state.columns.map((column) => {
                      const text = stringifyValue(row[column]);
                      const editable = state.editable && column !== state.rowIdColumn;
                      return (
                        <td key={column} title={text}>
                          <div
                            className={`cell${editable ? " editable" : ""}`}
                            contentEditable={editable}
                            suppressContentEditableWarning
                            spellCheck={false}
                            onBlur={(event) => {
                              if (!editable || rowid === null || rowid === undefined) {
                                return;
                              }
                              post(
                                {
                                  type: "results.updateCell",
                                  connectionId: state.connectionId,
                                  database: state.database,
                                  table: state.table,
                                  rowid: String(rowid),
                                  column,
                                  value: event.currentTarget.textContent ?? ""
                                },
                                "Saving..."
                              );
                            }}
                          >
                            {text}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="note">
          {state.resultCount > state.maxRows ? `Showing first ${state.maxRows} rows.` : ""}
        </div>
      </div>
    </>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing root element.");
}

createRoot(rootEl).render(<App />);
