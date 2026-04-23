import * as vscode from "vscode";

type RenderWebviewAppHtmlOptions = {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  title: string;
  scriptFile: string;
  state: unknown;
  stylesheets?: string[];
};

export function renderWebviewAppHtml(options: RenderWebviewAppHtmlOptions): string {
  const { webview, extensionUri, title, scriptFile, state, stylesheets = [] } = options;
  const cspSource = webview.cspSource;
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", scriptFile));
  const stateB64 = Buffer.from(JSON.stringify(state), "utf8").toString("base64");
  const linkTags = stylesheets
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("\n    ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; font-src ${cspSource}; style-src 'unsafe-inline' ${cspSource}; script-src ${cspSource};" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${linkTags}
    <style>
      html, body, #root { height: 100%; }
      body {
        margin: 0;
        padding: 0;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script id="mcState" type="application/json">${stateB64}</script>
    <script src="${scriptUri}"></script>
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
