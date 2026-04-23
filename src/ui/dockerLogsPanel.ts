import * as vscode from "vscode";
import { ansiToHtml } from "./ansiToHtml";
import type { DockerHost } from "../types";

export class DockerLogsPanel {
    private panel: vscode.WebviewPanel | undefined;
    private onMessageSub: vscode.Disposable | undefined;

    public constructor(
        private readonly ctx: vscode.ExtensionContext,
        private readonly onMessage?: (message: any) => void | Promise<void>
    ) { }

    public show(host: DockerHost, containerId: string, logs: string): void {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                "moreConnect.dockerLogs",
                `Docker Logs: ${containerId}`,
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
                } catch { }
            });
        }
        this.panel.title = `Docker Logs: ${containerId}`;
        this.panel.webview.html = renderHtml(containerId, logs);
    }

    public postMessage(message: any): void {
        try {
            this.panel?.webview.postMessage(message);
        } catch { }
    }
}

function renderHtml(containerId: string, logs: string): string {
    const safeLogs = typeof logs === "string" ? logs : "";
    const rawLines = safeLogs.length > 0 ? safeLogs.split(/\r?\n/g) : [];
    // 미리 변환된 HTML 라인 배열 생성 (모든 ANSI 지원)
    const htmlLines = rawLines.map(ansiToHtml);
    return `<!doctype html>
<html>
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
            html, body { height: 100%; margin: 0; padding: 0; }
            body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); height: 100vh; width: 100vw; margin: 0; padding: 0; display: flex; flex-direction: column; }
            .header { display: flex; align-items: center; gap: 12px; padding: 12px 12px 0 12px; }
            .header h2 { flex: 1; margin: 0; font-size: 1.2em; }
            .filter-box { font-size: 1em; padding: 4px 8px; border-radius: 4px; border: 1px solid #bbb; min-width: 180px; }
            .log-container { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
            .log-viewport { flex: 1; min-height: 0; margin: 12px; padding: 10px; overflow: auto; background: rgba(127,127,127,.12); border: 1px solid rgba(127,127,127,.25); border-radius: 6px; }
            pre { margin: 0; color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
            b { font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="header">
            <h2>컨테이너 로그: ${containerId}</h2>
            <input class="filter-box" id="filterInput" type="text" placeholder="필터 (예: error, warn, ...)">
        </div>
        <div class="log-container">
            <div class="log-viewport" id="logViewport">
                <pre id="logArea">${htmlLines.length ? htmlLines.join("\n") : "(로그 없음)"}</pre>
            </div>
        </div>
        <script>
            const htmlLines = ${JSON.stringify(htmlLines)};
            const rawLines = ${JSON.stringify(rawLines)};
            const logViewport = document.getElementById('logViewport');
            const logArea = document.getElementById('logArea');
            const filterInput = document.getElementById('filterInput');
            function render(filtered) {
                logArea.innerHTML = filtered.length ? filtered.join("\n") : "(로그 없음)";
            }
            function scrollToBottom() {
                if (!logViewport) {
                    return;
                }
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        logViewport.scrollTop = logViewport.scrollHeight;
                    });
                });
            }
            // 최초 진입시 tail
            render(htmlLines);
            scrollToBottom();
            // 필터 입력
            filterInput.addEventListener('input', function() {
                const q = filterInput.value.trim().toLowerCase();
                if (!q) {
                    render(htmlLines);
                } else {
                    // 필터는 원본 라인에서 적용, 변환된 htmlLines에서 매핑
                    const filtered = rawLines
                        .map((line, i) => ({ line, html: htmlLines[i] }))
                        .filter(obj => obj.line.toLowerCase().includes(q))
                        .map(obj => obj.html);
                    render(filtered);
                }
                scrollToBottom();
            });
        </script>
    </body>
</html>`;
}

function escapeHtml(s: string): string {
    return s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
