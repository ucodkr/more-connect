import * as vscode from "vscode";
import { ansiLinesToHtml, normalizeAnsiDisplayLine, stripAnsi } from "./ansiToHtml";
import type { DockerHost } from "../types";
import { renderWebviewAppHtml } from "./webviewAppShell";

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
        this.panel.webview.html = renderHtml(this.panel.webview, this.ctx.extensionUri, containerId, logs);
    }

    public isVisible(): boolean {
        return Boolean(this.panel);
    }

    public onDidDispose(listener: () => void): vscode.Disposable {
        if (!this.panel) {
            return new vscode.Disposable(() => { });
        }
        return this.panel.onDidDispose(listener);
    }

    public postMessage(message: any): void {
        try {
            this.panel?.webview.postMessage(message);
        } catch { }
    }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, containerId: string, logs: string): string {
        const safeLogs = typeof logs === "string" ? logs : "";
        const rawLines = safeLogs.length > 0 ? safeLogs.split(/\r?\n/g) : [];
        const htmlLines = ansiLinesToHtml(rawLines);
        const searchLines = rawLines.map((line) => stripAnsi(normalizeAnsiDisplayLine(line)));
        return renderWebviewAppHtml({
            webview,
            extensionUri,
            title: `Docker Logs: ${containerId}`,
            scriptFile: "dockerLogsApp.js",
            state: { containerId, rawLines: searchLines, htmlLines }
        });
}
