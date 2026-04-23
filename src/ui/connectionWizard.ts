import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ConnectionConfig, DbType } from "../types";
import { renderWebviewAppHtml } from "./webviewAppShell";

type WizardResult =
  | { kind: "cancel" }
  | { kind: "save"; config: ConnectionConfig; password?: string; sshPassword?: string; resetPassword?: boolean };
type WizardMessage = { type: "cancel" } | { type: "save"; payload: any } | { type: "test"; payload: any };

export class ConnectionWizard {
  private panel: vscode.WebviewPanel | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async open(existing?: ConnectionConfig): Promise<WizardResult> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "moreConnect.connectionWizard",
        existing ? "Edit Connection" : "Add Connection",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: false }
      );
      this.panel.onDidDispose(() => (this.panel = undefined), undefined, this.context.subscriptions);
    } else {
      this.panel.title = existing ? "Edit Connection" : "Add Connection";
      this.panel.reveal(vscode.ViewColumn.Active, true);
    }

    const panel = this.panel;
    panel.webview.html = renderHtml(panel.webview, this.context.extensionUri, existing);

    return await new Promise<WizardResult>((resolve) => {
      const sub = panel.webview.onDidReceiveMessage(
        async (msg: WizardMessage) => {
          if (msg?.type === "cancel") {
            sub.dispose();
            resolve({ kind: "cancel" });
            return;
          }
          if (msg?.type === "test") {
            await vscode.commands.executeCommand("moreConnect.testConnectionFromWizard", msg.payload);
            return;
          }
          if (msg?.type !== "save") return;

          try {
            const parsed = parseForm(existing, msg?.payload);
            sub.dispose();
            resolve(parsed);
          } catch (e) {
            panel.webview.postMessage({ type: "error", message: (e as Error).message });
          }
        },
        undefined,
        this.context.subscriptions
      );
    });
  }
}

function parseForm(existing: ConnectionConfig | undefined, payload: any): WizardResult {
  const type = String(payload?.type ?? "") as DbType;
  if (!type) throw new Error("Type is required.");
  const name = String(payload?.name ?? "").trim();
  if (!name) throw new Error("Name is required.");

  const id = existing?.id ?? randomUUID();
  const resetPassword = Boolean(payload?.resetPassword);
  const password = String(payload?.password ?? "");
  const sshEnabled = Boolean(payload?.sshEnabled);
  const sshPassword = String(payload?.sshPassword ?? "");
  const sshHost = String(payload?.sshHost ?? "").trim() || undefined;
  const sshPortRaw = String(payload?.sshPort ?? "").trim();
  const sshPort = sshPortRaw ? Number(sshPortRaw) : undefined;
  const sshUser = String(payload?.sshUser ?? "").trim() || undefined;
  const sshPrivateKeyPath = String(payload?.sshPrivateKeyPath ?? "").trim() || undefined;
  const sshRemoteHost = String(payload?.sshRemoteHost ?? "").trim() || undefined;
  const sshRemotePortRaw = String(payload?.sshRemotePort ?? "").trim();
  const sshRemotePort = sshRemotePortRaw ? Number(sshRemotePortRaw) : undefined;

  if (type === "sqlite") {
    const file = String(payload?.sqliteFilePath ?? "").trim();
    if (!file) throw new Error("SQLite file path is required.");
    const config: ConnectionConfig = {
      id,
      name,
      type,
      host: file,
      port: 0,
      user: "",
      sqliteFilePath: file,
      sshEnabled,
      sshHost,
      sshPort,
      sshUser,
      sshPrivateKeyPath,
      sshRemoteHost,
      sshRemotePort
    };
    return {
      kind: "save",
      config,
      sshPassword: sshPassword || undefined,
      resetPassword: resetPassword || undefined
    };
  }

  if (type === "redis") {
    const host = String(payload?.host ?? "").trim() || "127.0.0.1";
    const port = Number(payload?.port ?? 6379);
    if (!Number.isFinite(port)) throw new Error("Redis port must be a number.");
    const dbRaw = String(payload?.redisDatabase ?? "").trim();
    const redisDatabase = dbRaw.length ? Number(dbRaw) : undefined;
    if (redisDatabase !== undefined && !Number.isFinite(redisDatabase)) throw new Error("Redis DB must be a number.");
    const ssl = Boolean(payload?.ssl);
    const config: ConnectionConfig = {
      id,
      name,
      type,
      host,
      port,
      user: "",
      database: redisDatabase !== undefined ? String(redisDatabase) : undefined,
      redisDatabase,
      ssl,
      sshEnabled,
      sshHost,
      sshPort,
      sshUser,
      sshPrivateKeyPath,
      sshRemoteHost,
      sshRemotePort
    };
    return {
      kind: "save",
      config,
      password: password || undefined,
      sshPassword: sshPassword || undefined,
      resetPassword: resetPassword || undefined
    };
  }

  if (type === "oracle") {
    const connectString = String(payload?.oracleConnectString ?? payload?.host ?? "").trim();
    if (!connectString) throw new Error("Oracle connect string is required.");
    const user = String(payload?.user ?? "").trim();
    if (!user) throw new Error("User is required.");
    const database = String(payload?.database ?? "").trim() || undefined;
    const port = Number(payload?.port ?? 1521);
    const config: ConnectionConfig = {
      id,
      name,
      type,
      host: connectString,
      port: Number.isFinite(port) ? port : 1521,
      user,
      database,
      oracleConnectString: connectString,
      oraclePrivilege:
        String(payload?.oraclePrivilege ?? "").trim() === "sysdba"
          ? "sysdba"
          : String(payload?.oraclePrivilege ?? "").trim() === "sysoper"
            ? "sysoper"
            : "default",
      sshEnabled,
      sshHost,
      sshPort,
      sshUser,
      sshPrivateKeyPath,
      sshRemoteHost,
      sshRemotePort
    };
    return {
      kind: "save",
      config,
      password: password || undefined,
      sshPassword: sshPassword || undefined,
      resetPassword: resetPassword || undefined
    };
  }

  const host = String(payload?.host ?? "").trim();
  if (!host) throw new Error("Host is required.");
  const port = Number(payload?.port ?? (type === "postgres" ? 5432 : 3306));
  if (!Number.isFinite(port)) throw new Error("Port must be a number.");
  const user = String(payload?.user ?? "").trim();
  if (!user) throw new Error("User is required.");
  const database = String(payload?.database ?? "").trim() || undefined;
  const ssl = Boolean(payload?.ssl);

  const config: ConnectionConfig = {
    id,
    name,
    type,
    host,
    port,
    user,
    database,
    ssl,
    sshEnabled,
    sshHost,
    sshPort,
    sshUser,
    sshPrivateKeyPath,
    sshRemoteHost,
    sshRemotePort
  };
  return {
    kind: "save",
    config,
    password: password || undefined,
    sshPassword: sshPassword || undefined,
    resetPassword: resetPassword || undefined
  };
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, existing?: ConnectionConfig): string {
  const init = {
    name: existing?.name ?? "",
    type: existing?.type ?? "mysql",
    host: existing?.host ?? "localhost",
    port: existing?.port ?? (existing?.type === "postgres" ? 5432 : existing?.type === "redis" ? 6379 : 3306),
    user: existing?.user ?? "",
    database: existing?.database ?? "",
    ssl: Boolean(existing?.ssl),
    sqliteFilePath: existing?.sqliteFilePath ?? "",
    oracleConnectString: existing?.oracleConnectString ?? (existing?.type === "oracle" ? existing.host : ""),
    oraclePrivilege: existing?.oraclePrivilege ?? "default",
    redisDatabase: existing?.redisDatabase ?? (existing?.type === "redis" ? existing.database ?? "0" : "0"),
    sshEnabled: Boolean(existing?.sshEnabled),
    sshHost: existing?.sshHost ?? "",
    sshPort: String(existing?.sshPort ?? 22),
    sshUser: existing?.sshUser ?? "",
    sshPrivateKeyPath: existing?.sshPrivateKeyPath ?? "",
    sshRemoteHost: existing?.sshRemoteHost ?? "",
    sshRemotePort: String(existing?.sshRemotePort ?? ""),
    isEdit: Boolean(existing)
  };
  return renderWebviewAppHtml({
    webview,
    extensionUri,
    title: "Connection",
    scriptFile: "connectionWizardApp.js",
    state: init
  });
}
