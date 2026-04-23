import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { readState as readWebviewState } from "./shared";

type SshExplorerState = {
  title: string;
};

type DirEntry = {
  name: string;
  isDir: boolean;
  size: number;
  owner: string;
  group: string;
  permNum: string;
  permText: string;
};

type SshDirMessage = {
  type: "sshExplorer.dir";
  cwd: string;
  entries: DirEntry[];
};

type SshStatusMessage = {
  type: "sshExplorer.status";
  text: string;
};

const styles = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; }
  .page { padding: 12px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .button { background: transparent; color: inherit; border: 1px solid rgba(127,127,127,.35); padding: 6px 10px; border-radius: 6px; cursor: pointer; }
  .pathInput { flex: 1; min-width: 240px; padding: 7px 10px; border-radius: 6px; border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.12); color: inherit; }
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid rgba(127,127,127,.25); border-radius: 8px; background: rgba(127,127,127,.06); margin-bottom: 10px; }
  .crumb { padding: 2px 6px; border-radius: 6px; border: none; background: transparent; color: inherit; cursor: pointer; }
  .crumb:hover { background: rgba(127,127,127,.14); }
  .sep { opacity: .6; }
  .status { opacity: .85; margin-bottom: 10px; white-space: pre-wrap; }
  .status.error { color: var(--vscode-errorForeground); opacity: 1; }
  .tableWrap { overflow: auto; }
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { border-bottom: 1px solid rgba(127,127,127,.25); padding: 6px 8px; vertical-align: middle; text-align: left; }
  .table th { position: sticky; top: 0; background: var(--vscode-editor-background); }
  .right { text-align: right; }
  .nameCell { display: flex; gap: 8px; align-items: center; }
  .iconBtn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; border: none; background: transparent; color: inherit; opacity: .85; cursor: pointer; }
  .iconBtn:hover { background: rgba(127,127,127,.14); opacity: 1; }
  .fileIcon { width: 16px; display: inline-flex; align-items: center; justify-content: center; opacity: .9; }
  .nameButton { border: none; background: transparent; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; }
`;

function formatSize(value: number): string {
  if (!value) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? String(Math.round(current)) : String(Math.round(current * 10) / 10);
  return `${rounded} ${units[unitIndex]}`;
}

function App(): React.JSX.Element {
  const vscode = useMemo(() => acquireVsCodeApi(), []);
  const state = useMemo(() => readWebviewState<SshExplorerState>(), []);
  const [status, setStatus] = useState("Loading...");
  const [statusError, setStatusError] = useState(false);
  const [cwd, setCwd] = useState("");
  const [pathValue, setPathValue] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);

  useEffect(() => {
    document.title = state.title;
    vscode.postMessage({ type: "sshExplorer.ready" });
  }, [state.title, vscode]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<SshDirMessage | SshStatusMessage>) => {
      const msg = event.data;
      if (msg?.type === "sshExplorer.status") {
        setStatus(msg.text || "");
        setStatusError(/permission denied|authentication|batchmode|error|failed/i.test(msg.text || ""));
      }
      if (msg?.type === "sshExplorer.dir") {
        setCwd(msg.cwd || "");
        setPathValue(msg.cwd || "");
        setEntries((msg.entries ?? []).slice().sort((a, b) => {
          if (a.isDir !== b.isDir) {
            return a.isDir ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const breadcrumbs = useMemo(() => {
    if (!cwd || !cwd.startsWith("/")) {
      return cwd ? [{ label: `Path: ${cwd}`, path: cwd }] : [];
    }
    const parts = cwd.split("/").filter(Boolean);
    const items = [{ label: "/", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      items.push({ label: part, path: acc });
    }
    return items;
  }, [cwd]);

  return (
    <>
      <style>{styles}</style>
      <div className="page">
        <div className="toolbar">
          <button className="button" type="button" onClick={() => vscode.postMessage({ type: "sshExplorer.up" })}>..</button>
          <button className="button" type="button" onClick={() => vscode.postMessage({ type: "sshExplorer.refresh", path: pathValue })}>Refresh</button>
          <input
            className="pathInput"
            spellCheck={false}
            placeholder="Remote path (supports ~)"
            value={pathValue}
            onChange={(event) => setPathValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                vscode.postMessage({ type: "sshExplorer.cd", path: pathValue });
              }
            }}
          />
          <button className="button" type="button" onClick={() => vscode.postMessage({ type: "sshExplorer.cd", path: pathValue })}>Go</button>
        </div>
        {breadcrumbs.length ? (
          <div className="crumbs">
            {breadcrumbs.map((crumb, index) => (
              <React.Fragment key={crumb.path}>
                {index > 0 ? <span className="sep">›</span> : null}
                <button className="crumb" type="button" onClick={() => vscode.postMessage({ type: "sshExplorer.cd", path: crumb.path })}>
                  {crumb.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        ) : null}
        <div className={`status${statusError ? " error" : ""}`}>{status}</div>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="right">Size</th>
                <th>Owner</th>
                <th>Perm</th>
                <th className="right">Action</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={`${entry.isDir ? "d" : "f"}:${entry.name}`}>
                  <td>
                    <div className="nameCell">
                      <span className="fileIcon">
                        <i className={`codicon ${entry.isDir ? "codicon-folder" : "codicon-file"}`} aria-hidden="true" />
                      </span>
                      {entry.isDir ? (
                        <button className="nameButton" type="button" onClick={() => vscode.postMessage({ type: "sshExplorer.openDir", name: entry.name })}>
                          {entry.name}
                        </button>
                      ) : (
                        <span>{entry.name}</span>
                      )}
                    </div>
                  </td>
                  <td className="right">{entry.isDir ? "" : formatSize(Number(entry.size || 0))}</td>
                  <td>{entry.owner && entry.group ? `${entry.owner}:${entry.group}` : entry.owner || entry.group}</td>
                  <td>{entry.permText && entry.permNum ? `${entry.permText} (${entry.permNum})` : entry.permText || entry.permNum}</td>
                  <td className="right">
                    {!entry.isDir ? (
                      <button className="iconBtn" type="button" title="View" onClick={() => vscode.postMessage({ type: "sshExplorer.view", name: entry.name })}>
                        <i className="codicon codicon-eye" aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      className="iconBtn"
                      type="button"
                      title={entry.isDir ? "Open" : "Download"}
                      onClick={() => vscode.postMessage({ type: entry.isDir ? "sshExplorer.openDir" : "sshExplorer.download", name: entry.name })}
                    >
                      <i className={`codicon ${entry.isDir ? "codicon-folder-opened" : "codicon-cloud-download"}`} aria-hidden="true" />
                    </button>
                    <button className="iconBtn" type="button" title="Delete" onClick={() => vscode.postMessage({ type: "sshExplorer.delete", name: entry.name, isDir: entry.isDir })}>
                      <i className="codicon codicon-trash" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
