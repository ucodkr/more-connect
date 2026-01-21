import * as vscode from "vscode";

export class InfoPanel {
  private panel: vscode.WebviewPanel | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public show(title: string, htmlBody: string): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "moreConnect.info",
        title,
        vscode.ViewColumn.Beside,
        { enableScripts: false, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => (this.panel = undefined), undefined, this.context.subscriptions);
    }

    this.panel.title = title;
    this.panel.webview.html = this.renderHtml(title, htmlBody);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private renderHtml(title: string, body: string): string {
    const nonce = String(Date.now());
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe WPC, Segoe UI, sans-serif; padding: 12px 14px; }
    h1 { font-size: 14px; margin: 0 0 10px 0; }
    h2 { font-size: 12px; margin: 14px 0 8px 0; opacity: 0.9; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid rgba(127,127,127,0.25); padding: 6px 8px; text-align: left; font-size: 12px; }
    th { position: sticky; top: 0; background: rgba(127,127,127,0.10); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

