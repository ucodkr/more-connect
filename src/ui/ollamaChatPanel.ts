import * as vscode from "vscode";
import { renderWebviewAppHtml } from "./webviewAppShell";

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
  return renderWebviewAppHtml({
    webview,
    extensionUri,
    title: `Ollama: ${input.endpointName}`,
    scriptFile: "ollamaChatPanel.js",
    state
  });
}
