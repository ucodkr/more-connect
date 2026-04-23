import * as vscode from "vscode";
import { renderWebviewAppHtml } from "./webviewAppShell";

type InfoPanelOptions = {
  showRefreshButton?: boolean;
  onRefresh?: () => void | Promise<void>;
};

export class InfoPanel {
  private panel: vscode.WebviewPanel | undefined;
  private onRefresh: (() => void | Promise<void>) | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public show(title: string, htmlBody: string, options?: InfoPanelOptions): void {
    this.onRefresh = options?.onRefresh;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "moreConnect.info",
        title,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.webview.onDidReceiveMessage(
        async (msg: unknown) => {
          if ((msg as { type?: string } | undefined)?.type !== "info.refresh") return;
          if (!this.onRefresh) return;
          await this.onRefresh();
        },
        undefined,
        this.context.subscriptions
      );
      this.panel.onDidDispose(() => (this.panel = undefined), undefined, this.context.subscriptions);
    }

    this.panel.title = title;
    this.panel.webview.html = this.renderHtml(this.panel.webview, title, htmlBody, Boolean(options?.showRefreshButton));
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private renderHtml(webview: vscode.Webview, title: string, body: string, showRefreshButton: boolean): string {
    return renderWebviewAppHtml({
      webview,
      extensionUri: this.context.extensionUri,
      title,
      scriptFile: "infoPanelApp.js",
      state: { title, body, showRefreshButton }
    });
  }
}
