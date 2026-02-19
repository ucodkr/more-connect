import * as vscode from "vscode";

export type OllamaChatRole = "user" | "assistant" | "system";

export type OllamaChatMessage = {
  role: OllamaChatRole;
  content: string;
  meta?: {
    inputTokens?: number;
    outputTokens?: number;
    totalMs?: number;
    tokensPerSec?: number;
  };
};

type OllamaChatPanelInput = {
  endpointId: string;
  endpointName: string;
  endpointUrl: string;
  model: string;
  models: string[];
  sessionId?: string;
  sessions?: Array<{ id: string; name: string; updatedAt: number }>;
  modelInfos?: Record<
    string,
    {
      name?: string;
      sizeBytes?: number;
      parameterSize?: string;
      quantization?: string;
      contextLimit?: number;
      family?: string;
      format?: string;
    }
  >;
  messages: OllamaChatMessage[];
};

export class OllamaChatPanel {
  private readonly panels = new Map<
    string,
    { panel: vscode.WebviewPanel; onMessageSub: vscode.Disposable }
  >();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onMessage?: (panelKey: string, message: any) => void | Promise<void>
  ) {}

  public show(panelKey: string, input: OllamaChatPanelInput): void {
    let entry = this.panels.get(panelKey);
    if (!entry) {
      const panel = vscode.window.createWebviewPanel(
        "moreConnect.ollamaChat",
        `More Connect: Ollama Chat (${input.endpointName})`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const onMessageSub = panel.webview.onDidReceiveMessage(async (msg) => {
        try {
          await this.onMessage?.(panelKey, msg);
        } catch {}
      });
      panel.onDidDispose(() => {
        onMessageSub.dispose();
        this.panels.delete(panelKey);
      });
      entry = { panel, onMessageSub };
      this.panels.set(panelKey, entry);
    }
    entry.panel.title = `Ollama: ${input.endpointName}`;
    entry.panel.webview.html = renderHtml(input, entry.panel.webview, this.context.extensionUri);
    entry.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  public postMessage(panelKey: string, message: any): void {
    try {
      this.panels.get(panelKey)?.panel.webview.postMessage(message);
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

function renderHtml(input: OllamaChatPanelInput, webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const state = {
    endpointId: input.endpointId,
    endpointName: input.endpointName,
    endpointUrl: input.endpointUrl,
    model: input.model,
    models: input.models ?? [],
    sessionId: input.sessionId ?? "",
    sessions: input.sessions ?? [],
    modelInfos: input.modelInfos ?? {},
    messages: input.messages
  };
  const stateB64 = Buffer.from(JSON.stringify(state), "utf8").toString("base64");
  const cspSource = webview.cspSource;
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "ollamaChatPanel.js"));
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${cspSource};" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
      .top { padding: 10px 12px; border-bottom: 1px solid rgba(127,127,127,.25); display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
      .meta { font-size: 12px; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
      .modelInfo { padding: 0 12px 8px 12px; font-size: 11px; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .actions { display: flex; gap: 8px; flex-shrink: 0; }
      select { background: rgba(127,127,127,.10); color: inherit; border: 1px solid rgba(127,127,127,.35); border-radius: 6px; padding: 4px 8px; font-size: 12px; width: 220px; max-width: 40vw; }
      button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
      button.secondary { background: transparent; border: 1px solid rgba(127,127,127,.35); color: inherit; }
      .messages { padding: 12px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
      .msg { max-width: 88%; padding: 10px 12px; border-radius: 10px; line-height: 1.45; word-break: break-word; }
      .msg .content { white-space: normal; }
      .msg .meta { margin-top: 6px; font-size: 11px; opacity: .75; }
      .msg.user { align-self: flex-end; background: rgba(80,160,255,.20); border: 1px solid rgba(80,160,255,.32); }
      .msg.assistant { align-self: flex-start; background: rgba(127,127,127,.16); border: 1px solid rgba(127,127,127,.28); }
      .msg.system { align-self: center; background: rgba(255,190,80,.15); border: 1px solid rgba(255,190,80,.32); font-size: 12px; }
      .msg.assistant h1, .msg.assistant h2, .msg.assistant h3 { margin: 0 0 8px 0; line-height: 1.25; }
      .msg.assistant p { margin: 0 0 8px 0; }
      .msg.assistant ul, .msg.assistant ol { margin: 0 0 8px 20px; padding: 0; }
      .msg.assistant pre { margin: 8px 0; padding: 10px; border-radius: 8px; overflow: auto; background: rgba(0,0,0,.25); border: 1px solid rgba(127,127,127,.25); }
      .msg.assistant code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
      .msg.assistant :not(pre) > code { padding: 1px 5px; border-radius: 5px; background: rgba(127,127,127,.2); }
      .msg.assistant blockquote { margin: 8px 0; padding-left: 10px; border-left: 3px solid rgba(127,127,127,.45); opacity: .9; }
      .msg.assistant a { color: var(--vscode-textLink-foreground); text-decoration: underline; }
      .composer { border-top: 1px solid rgba(127,127,127,.25); padding: 10px; display: grid; grid-template-columns: 1fr auto; gap: 8px; }
      textarea { width: 100%; min-height: 56px; max-height: 220px; resize: vertical; box-sizing: border-box; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.08); color: inherit; padding: 10px; font: inherit; }
      .status { font-size: 12px; opacity: .8; padding: 0 10px 8px; }
      .status.error { color: var(--vscode-errorForeground); opacity: 1; }
      .typing .dots span { opacity: .25; animation: blink 1.1s infinite; }
      .typing .dots span:nth-child(2) { animation-delay: .2s; }
      .typing .dots span:nth-child(3) { animation-delay: .4s; }
      @keyframes blink { 0%, 80%, 100% { opacity: .2; } 40% { opacity: 1; } }
    </style>
  </head>
  <body>
    <div class="top">
      <div class="meta"><strong>${escapeHtml(input.endpointName)}</strong> (${escapeHtml(input.endpointUrl)})</div>
      <div class="actions">
        <select id="modelSelect" title="Model"></select>
        <select id="sessionSelect" title="Session"></select>
        <button class="secondary" id="newSessionBtn" type="button">New Session</button>
        <button class="secondary" id="deleteSessionBtn" type="button">Delete Session</button>
        <button class="secondary" id="stopBtn" type="button" disabled>Stop</button>
        <button class="secondary" id="clearBtn" type="button">Clear</button>
      </div>
    </div>
    <div id="modelInfo" class="modelInfo"></div>
    <div id="messages" class="messages"></div>
    <div>
      <div class="composer">
        <textarea id="prompt" spellcheck="false" placeholder="메시지를 입력하세요. Enter 전송 / Shift+Enter 줄바꿈"></textarea>
        <button id="sendBtn" type="button">Send</button>
      </div>
      <div id="status" class="status"></div>
    </div>
    <script id="mcState" type="application/json">${escapeHtml(stateB64)}</script>
    <script src="${scriptUri}"></script>
  </body>
</html>`;
}
