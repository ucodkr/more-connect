import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { readState as readWebviewState } from "./shared";

type DockerLogsState = {
  containerId: string;
  rawLines: string[];
  htmlLines: string[];
};

type DockerLogsMessage = {
  type: "dockerLogs.setLogs";
  payload: DockerLogsState;
};

const styles = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; }
  .page { height: 100%; display: flex; flex-direction: column; }
  .header { display: flex; align-items: center; gap: 12px; padding: 12px 12px 0 12px; }
  .title { flex: 1; margin: 0; font-size: 1.1rem; }
  .filterBox { min-width: 180px; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(127,127,127,.35); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .viewport { flex: 1; min-height: 0; margin: 12px; padding: 10px; overflow: auto; background: rgba(127,127,127,.12); border: 1px solid rgba(127,127,127,.25); border-radius: 6px; }
  .pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    tab-size: 4;
    -moz-tab-size: 4;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }
`;

function App(): React.JSX.Element {
  const initialState = useMemo(() => readWebviewState<DockerLogsState>(), []);
  const [state, setState] = useState(initialState);
  const [query, setQuery] = useState("");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  const filteredHtml = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return state.htmlLines;
    }
    return state.rawLines
      .map((line, index) => ({ line, html: state.htmlLines[index] }))
      .filter((item) => item.line.toLowerCase().includes(q))
      .map((item) => item.html);
  }, [query, state.htmlLines, state.rawLines]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<DockerLogsMessage>) => {
      if (event.data?.type === "dockerLogs.setLogs") {
        setState(event.data.payload);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !pinnedToBottomRef.current) {
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight;
      });
    });
  }, [filteredHtml]);

  return (
    <>
      <style>{styles}</style>
      <div className="page">
        <div className="header">
          <h2 className="title">컨테이너 로그: {state.containerId}</h2>
          <input
            className="filterBox"
            type="text"
            placeholder="필터 (예: error, warn, ...)"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div
          ref={viewportRef}
          className="viewport"
          onScroll={(event) => {
            const viewport = event.currentTarget;
            const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
            pinnedToBottomRef.current = remaining < 24;
          }}
        >
          <pre
            className="pre"
            dangerouslySetInnerHTML={{ __html: filteredHtml.length ? filteredHtml.join("\n") : "(로그 없음)" }}
          />
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
