import React, { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { readState as readWebviewState } from "./shared";

type InfoPanelState = {
  title: string;
  body: string;
  showRefreshButton: boolean;
};

const styles = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe WPC, Segoe UI, sans-serif; }
  .page { padding: 12px 14px; min-height: 100%; }
  .toolbar { display: flex; justify-content: flex-end; margin: 0 0 10px 0; }
  .button { border: 1px solid rgba(127,127,127,0.45); background: transparent; color: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .button:hover { background: rgba(127,127,127,0.12); }
  .content h1 { font-size: 14px; margin: 0 0 10px 0; }
  .content h2 { font-size: 12px; margin: 14px 0 8px 0; opacity: .9; }
  .content table { width: 100%; border-collapse: collapse; }
  .content th, .content td { border-bottom: 1px solid rgba(127,127,127,0.25); padding: 6px 8px; text-align: left; font-size: 12px; }
  .content th { position: sticky; top: 0; background: rgba(127,127,127,0.10); }
  .content code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; }
`;

function App(): React.JSX.Element {
  const vscode = useMemo(() => acquireVsCodeApi(), []);
  const state = useMemo(() => readWebviewState<InfoPanelState>(), []);

  return (
    <>
      <style>{styles}</style>
      <div className="page">
        {state.showRefreshButton ? (
          <div className="toolbar">
            <button className="button" type="button" onClick={() => vscode.postMessage({ type: "info.refresh" })}>
              새로고침
            </button>
          </div>
        ) : null}
        <div className="content" dangerouslySetInnerHTML={{ __html: state.body }} />
      </div>
    </>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing root element.");
}

createRoot(rootEl).render(<App />);
