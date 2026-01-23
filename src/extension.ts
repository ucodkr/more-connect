import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { ConnectionConfig, DbType } from "./types";
import { ConnectionStore } from "./storage";
import { createClient, type OptionalModuleLoader } from "./db/factory";
import type { DbClient } from "./db/client";
import { ResultsPanel } from "./ui/resultsPanel";
import { InfoPanel } from "./ui/infoPanel";
import { ConnectionWizard } from "./ui/connectionWizard";
import { ExplorerView, type ExplorerNode } from "./ui/explorerView";
import { TunnelManager } from "./ssh/tunnelManager";
import { RedisClient } from "./db/redisClient";
import { SshStore } from "./ssh/sshStore";
import { parseSshConfig, readUserSshConfigText, sshConnectionsFromConfig } from "./ssh/sshConfig";

const SECRET_PREFIX = "moreConnect.password.";
const SSH_SECRET_PREFIX = "moreConnect.sshPassword.";
const ACTIVE_CONNECTION_KEY = "moreConnect.activeConnectionId";
const SAVED_SQL_KEY = "moreConnect.savedSql.v1";
const SQL_FILE_CONTEXT_KEY = "moreConnect.sqlFileContext.v1";

type SavedSql = {
  id: string;
  name: string;
  sql: string;
  connectionId?: string;
  database?: string;
  favorite?: boolean;
  updatedAt: number;
};

type SqlFileContext = {
  connectionId?: string;
  database?: string;
  updatedAt: number;
};

export async function activate(context: vscode.ExtensionContext) {
  const store = new ConnectionStore(context);
  await store.init(context.globalState);
  const sshStore = new SshStore(context);
  await sshStore.init();
  const output = vscode.window.createOutputChannel("More Connect");
  logStoragePaths(output, context, store);
  const resultsPanel = new ResultsPanel(context, async (msg) => {
    await handleResultsPanelMessage(msg);
  });
  const infoPanel = new InfoPanel(context);
  const connectionWizard = new ConnectionWizard(context);
  const sqlStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sqlStatus.name = "More Connect SQL Context";
  sqlStatus.command = "moreConnect.selectConnectionForSql";
  context.subscriptions.push(sqlStatus);

  const clientsByKey = new Map<string, DbClient>();
  const driverDir = vscode.Uri.joinPath(context.globalStorageUri, "drivers");
  const moduleLoader: OptionalModuleLoader = createGlobalStorageModuleLoader(driverDir.fsPath);
  const tunnels = new TunnelManager(moduleLoader);

  // Ensure global storage folders exist (VS Code creates them lazily otherwise).
  try {
    await vscode.workspace.fs.createDirectory(driverDir);
  } catch {}

  function getActiveConnectionId(): string | undefined {
    return context.globalState.get<string>(ACTIVE_CONNECTION_KEY);
  }

  async function setActiveConnectionId(id: string | undefined): Promise<void> {
    await context.globalState.update(ACTIVE_CONNECTION_KEY, id);
    view.refresh();
    updateSqlStatus();
  }

  function getSqlFileContext(uri: vscode.Uri): SqlFileContext | undefined {
    const all = context.globalState.get<Record<string, SqlFileContext>>(SQL_FILE_CONTEXT_KEY, {});
    return all[uri.toString()];
  }

  async function setSqlFileContext(uri: vscode.Uri, next: Omit<SqlFileContext, "updatedAt">): Promise<void> {
    const all = context.globalState.get<Record<string, SqlFileContext>>(SQL_FILE_CONTEXT_KEY, {});
    all[uri.toString()] = { ...next, updatedAt: Date.now() };
    await context.globalState.update(SQL_FILE_CONTEXT_KEY, all);
    updateSqlStatus();
  }

  function listSavedSql(): SavedSql[] {
    return context.globalState.get<SavedSql[]>(SAVED_SQL_KEY, []);
  }

  async function upsertSavedSql(entry: Omit<SavedSql, "updatedAt"> & { updatedAt?: number }): Promise<void> {
    const all = listSavedSql();
    const updatedAt = entry.updatedAt ?? Date.now();
    const existingIndex = all.findIndex((s) => s.id === entry.id);
    const next: SavedSql = { ...entry, updatedAt };
    if (existingIndex >= 0) {
      all.splice(existingIndex, 1, next);
    } else {
      all.unshift(next);
    }
    await context.globalState.update(SAVED_SQL_KEY, all.slice(0, 200));
  }

  function clientKey(config: ConnectionConfig, databaseOverride?: string): string {
    const db = databaseOverride ?? config.database ?? "";
    return `${config.id}::${db}`;
  }

  const view = new ExplorerView({
    listConnections: () => store.list(),
    listSshConnections: () => sshStore.list(),
    isConnected: (id) => {
      for (const [key, client] of clientsByKey.entries()) {
        if (key.startsWith(`${id}::`) && client.isConnected) return true;
      }
      return false;
    },
    getActiveConnectionId,
    listFavoriteSql: (connectionId, database) => {
      const all = listSavedSql();
      return all
        .filter((s) => s.favorite === true && s.connectionId === connectionId && (s.database ?? "") === (database ?? ""))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .map((s) => ({ id: s.id, name: s.name, sql: s.sql }));
    },
    listDatabases: async (config) => {
      const client = await getOrCreateClient(config);
      if (!client.isConnected) await connect(config);
      if (!client.isConnected) return [];
      return await client.listDatabases();
    },
    listTables: async (config, database) => {
      const client = await getOrCreateClient(config, database);
      if (!client.isConnected) await connect({ ...config, database });
      if (!client.isConnected) return [];
      return await client.listTables(database);
    }
  });

  const DND_MIME = "application/vnd.more-connect.connection";
  const dragAndDropController: vscode.TreeDragAndDropController<ExplorerNode> = {
    dragMimeTypes: [DND_MIME],
    dropMimeTypes: [DND_MIME],
    handleDrag: async (source, dataTransfer) => {
      const items = source
        .map((n) => {
          if (n.kind === "connection") return { kind: "db", id: n.config.id };
          if (n.kind === "ssh") return { kind: "ssh", id: n.conn.id };
          return;
        })
        .filter(Boolean);
      if (items.length === 0) return;
      dataTransfer.set(DND_MIME, new vscode.DataTransferItem(JSON.stringify(items)));
    },
    handleDrop: async (target, dataTransfer) => {
      const raw = dataTransfer.get(DND_MIME)?.value;
      if (typeof raw !== "string") return;
      let dragged: Array<{ kind: "db" | "ssh"; id: string }> = [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) dragged = parsed;
      } catch {
        return;
      }
      if (dragged.length === 0) return;

      const dragKind = dragged[0].kind;
      if (!dragged.every((d) => d.kind === dragKind)) return;

      const targetKind =
        target?.kind === "group"
          ? target.group
          : target?.kind === "connection"
            ? "db"
            : target?.kind === "ssh"
              ? "ssh"
              : undefined;
      if (!targetKind || targetKind !== dragKind) return;

      const insertBeforeId =
        dragKind === "db"
          ? target?.kind === "connection"
            ? target.config.id
            : undefined
          : target?.kind === "ssh"
            ? target.conn.id
            : undefined;

      if (dragKind === "db") {
        const all = store.list();
        const draggedIds = new Set(dragged.map((d) => d.id));
        const remaining = all.filter((c) => !draggedIds.has(c.id));
        const moved = all.filter((c) => draggedIds.has(c.id));
        const idx = insertBeforeId ? remaining.findIndex((c) => c.id === insertBeforeId) : -1;
        const next = idx >= 0 ? [...remaining.slice(0, idx), ...moved, ...remaining.slice(idx)] : [...remaining, ...moved];
        await store.saveAll(next);
      } else {
        const all = sshStore.list();
        const draggedIds = new Set(dragged.map((d) => d.id));
        const remaining = all.filter((c) => !draggedIds.has(c.id));
        const moved = all.filter((c) => draggedIds.has(c.id));
        const idx = insertBeforeId ? remaining.findIndex((c) => c.id === insertBeforeId) : -1;
        const next = idx >= 0 ? [...remaining.slice(0, idx), ...moved, ...remaining.slice(idx)] : [...remaining, ...moved];
        await sshStore.saveAll(next);
      }

      view.refresh();
    }
  };

  const treeView = vscode.window.createTreeView("moreConnectConnections", {
    treeDataProvider: view,
    dragAndDropController
  });
  context.subscriptions.push(treeView, output);

  function postResultsStatus(text: string): void {
    resultsPanel.postMessage({ type: "results.status", text });
  }

  async function getOrCreateClient(config: ConnectionConfig, databaseOverride?: string): Promise<DbClient> {
    const key = clientKey(config, databaseOverride);
    const existing = clientsByKey.get(key);
    if (existing) return existing;
    const client = createClient({ ...config, database: databaseOverride ?? config.database }, moduleLoader);
    clientsByKey.set(key, client);
    return client;
  }

  async function promptConnectionConfig(existing?: ConnectionConfig): Promise<{
    config: ConnectionConfig;
    password?: string;
    sshPassword?: string;
    resetPassword?: boolean;
  } | undefined> {
    const res = await connectionWizard.open(existing);
    if (res.kind !== "save") return;
    return {
      config: res.config,
      password: res.password,
      sshPassword: res.sshPassword,
      resetPassword: res.resetPassword
    };
  }

  async function promptConnectionConfigFromPayload(payload: any): Promise<{
    config: ConnectionConfig;
    password?: string;
    sshPassword?: string;
  } | undefined> {
    // Reuse wizard parser by round-tripping through ConnectionWizard.open is overkill; payload already mirrors it.
    // Keep validation minimal here; ConnectionWizard will show field-level errors for Save, but Test can be direct.
    const type = String(payload?.type ?? "");
    const name = String(payload?.name ?? "").trim() || `${type}-test`;
    const baseId = String(payload?.id ?? "") || randomUUID();
    const config: ConnectionConfig = {
      id: baseId,
      name,
      type: type as any,
      host: String(payload?.host ?? "").trim(),
      port: Number(payload?.port ?? 0),
      user: String(payload?.user ?? "").trim(),
      database: String(payload?.database ?? "").trim() || undefined,
      ssl: Boolean(payload?.ssl),
      sqliteFilePath: String(payload?.sqliteFilePath ?? "").trim() || undefined,
      oracleConnectString: String(payload?.oracleConnectString ?? "").trim() || undefined,
      oraclePrivilege:
        String(payload?.oraclePrivilege ?? "").trim() === "sysdba"
          ? "sysdba"
          : String(payload?.oraclePrivilege ?? "").trim() === "sysoper"
            ? "sysoper"
            : "default",
      redisDatabase: payload?.redisDatabase !== undefined && String(payload.redisDatabase).trim() !== "" ? Number(payload.redisDatabase) : undefined,
      sshEnabled: Boolean(payload?.sshEnabled),
      sshHost: String(payload?.sshHost ?? "").trim() || undefined,
      sshPort: payload?.sshPort !== undefined && String(payload.sshPort).trim() !== "" ? Number(payload.sshPort) : undefined,
      sshUser: String(payload?.sshUser ?? "").trim() || undefined,
      sshPrivateKeyPath: String(payload?.sshPrivateKeyPath ?? "").trim() || undefined,
      sshRemoteHost: String(payload?.sshRemoteHost ?? "").trim() || undefined,
      sshRemotePort: payload?.sshRemotePort !== undefined && String(payload.sshRemotePort).trim() !== "" ? Number(payload.sshRemotePort) : undefined
    };
    const password = String(payload?.password ?? "");
    const sshPassword = String(payload?.sshPassword ?? "");
    return { config, password: password || undefined, sshPassword: sshPassword || undefined };
  }

  async function ensurePassword(config: ConnectionConfig): Promise<string | undefined> {
    if (config.type === "sqlite" || config.type === "redis") return "";
    const key = `${SECRET_PREFIX}${config.id}`;
    const existing = await context.secrets.get(key);
    if (existing !== undefined) {
      // eslint-disable-next-line no-console
      console.log("[more-connect] using saved db password", { id: config.id });
      return existing;
    }

    const password = await vscode.window.showInputBox({
      title: `Password for ${config.name}`,
      password: true,
      ignoreFocusOut: true
    });
    if (password === undefined) return;
    if (password.trim().length === 0) {
      vscode.window.showInformationMessage("Password is required.");
      return;
    }
    await context.secrets.store(key, password);
    // eslint-disable-next-line no-console
    console.log("[more-connect] stored db password", { id: config.id });
    return password;
  }

  async function ensureSshPassword(config: ConnectionConfig): Promise<string | undefined> {
    if (!config.sshEnabled) return;
    const key = `${SSH_SECRET_PREFIX}${config.id}`;
    const existing = await context.secrets.get(key);
    if (existing !== undefined) {
      // eslint-disable-next-line no-console
      console.log("[more-connect] using saved ssh password", { id: config.id });
      return existing;
    }
    const password = await vscode.window.showInputBox({
      title: `SSH Password for ${config.name} (optional)`,
      password: true,
      ignoreFocusOut: true
    });
    if (password === undefined) return;
    if (password.trim().length === 0) return "";
    await context.secrets.store(key, password);
    // eslint-disable-next-line no-console
    console.log("[more-connect] stored ssh password", { id: config.id });
    return password;
  }

  async function connect(config: ConnectionConfig): Promise<void> {
    if (config.sshEnabled) {
      const sshPw = await ensureSshPassword(config);
      if (sshPw === undefined) return;
      try {
        const forwarded = await tunnels.ensureTunnel(config, sshPw);
        if (forwarded) {
          config = { ...config, host: forwarded.host, port: forwarded.port };
        }
      } catch (e) {
        const err = e as Error;
        if (err.message?.startsWith("Missing driver:")) {
          await showMissingDriverHelp(context, driverDir.fsPath, err.message);
          return;
        }
        throw e;
      }
    }
    const client = await getOrCreateClient(config);
    if (client.isConnected) return;
    const password = await ensurePassword(config);
    if (password === undefined) return;
    try {
      await client.connect(password);
    } catch (e) {
      const err = e as Error;
      if (err.message?.startsWith("Missing driver:")) {
        await showMissingDriverHelp(context, driverDir.fsPath, err.message);
        return;
      }
      throw e;
    }
    view.refresh();
  }

  async function testConnection(
    config: ConnectionConfig,
    password: string | undefined,
    sshPassword: string | undefined
  ): Promise<void> {
    let effective = config;
    if (effective.sshEnabled) {
      try {
        const forwarded = await tunnels.ensureTunnel(effective, sshPassword);
        if (forwarded) effective = { ...effective, host: forwarded.host, port: forwarded.port };
      } catch (e) {
        const err = e as Error;
        if (err.message?.startsWith("Missing driver:")) {
          await showMissingDriverHelp(context, driverDir.fsPath, err.message);
          return;
        }
        throw e;
      }
    }

    const client = await getOrCreateClient(effective);
    if (client.isConnected) {
      vscode.window.showInformationMessage("Connection OK (already connected).");
      return;
    }

    const pw = effective.type === "sqlite" ? "" : password ?? "";
    try {
      await client.connect(pw);
      // lightweight sanity query
      if (effective.type === "postgres") await client.query("SELECT 1;");
      else if (effective.type === "mysql" || effective.type === "mariadb") await client.query("SELECT 1;");
      else if (effective.type === "sqlite") await client.query("SELECT 1;");
      else if (effective.type === "oracle") await client.query("SELECT 1 FROM DUAL");
      else if (effective.type === "redis") await client.query("PING");
      vscode.window.showInformationMessage("Connection OK.");
    } catch (e) {
      const err = e as Error;
      if (err.message?.startsWith("Missing driver:")) {
        await showMissingDriverHelp(context, driverDir.fsPath, err.message);
        return;
      }
      vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
    } finally {
      try {
        await client.disconnect();
      } catch {}
    }
  }

  async function disconnect(config: ConnectionConfig): Promise<void> {
    const keys: string[] = [];
    for (const [key, client] of clientsByKey.entries()) {
      if (!key.startsWith(`${config.id}::`)) continue;
      keys.push(key);
      try {
        await client.disconnect();
      } catch {}
    }
    for (const k of keys) clientsByKey.delete(k);
    try {
      await tunnels.closeTunnel(config.id);
    } catch {}
    view.refresh();
  }

  function isLikelyDisconnectedError(err: unknown): boolean {
    const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
    return (
      msg.includes("not connected") ||
      msg.includes("connection terminated") ||
      msg.includes("connection lost") ||
      msg.includes("econnreset") ||
      msg.includes("server closed the connection") ||
      msg.includes("dpi-1010") || // node-oracledb: not connected
      msg.includes("ora-03114") ||
      msg.includes("ora-03113") ||
      msg.includes("ora-00028") ||
      msg.includes("protocol_connection_lost") ||
      msg.includes("cannot enqueue query") ||
      msg.includes("client has encountered a connection error")
    );
  }

  async function ensureConnectedWithRetry(config: ConnectionConfig, actionLabel: string): Promise<boolean> {
    const client = await getOrCreateClient(config);
    if (!client.isConnected) {
      await connect(config);
      return client.isConnected;
    }
    // Client thinks it's connected; validate with a cheap ping to catch stale sockets.
    try {
      if (config.type === "postgres") await client.query("SELECT 1;");
      else if (config.type === "mysql" || config.type === "mariadb") await client.query("SELECT 1;");
      else if (config.type === "sqlite") await client.query("SELECT 1;");
      else if (config.type === "oracle") await client.query("SELECT 1 FROM DUAL");
      else if (config.type === "redis") await client.query("PING");
      return true;
    } catch (e) {
      if (!isLikelyDisconnectedError(e)) throw e;
      const choice = await vscode.window.showWarningMessage(
        `Connection looks disconnected. Reconnect to continue ${actionLabel}?`,
        { modal: true },
        "Reconnect",
        "Cancel"
      );
      if (choice !== "Reconnect") return false;
      try {
        await disconnect(config);
      } catch {}
      await connect(config);
      return (await getOrCreateClient(config)).isConnected;
    }
  }

  async function runQuery(config: ConnectionConfig, sql: string): Promise<void> {
    const client = await getOrCreateClient(config);
    if (!(await ensureConnectedWithRetry(config, "running query"))) return;

    output.show(true);
    output.appendLine(`\n[${new Date().toISOString()}] ${config.name} — Running query...`);
    output.appendLine(sql);

    const result = await client.query(sql);
    output.appendLine(`Result: rows=${result.rowCount ?? result.rows.length}, duration=${result.durationMs}ms`);
    resultsPanel.show(config, sql, result);
  }

  function getActiveConnection(): ConnectionConfig | undefined {
    const connections = store.list();
    const activeId = getActiveConnectionId();
    return activeId ? connections.find((c) => c.id === activeId) : undefined;
  }

  function pickConnectedOrAnyConnection(): ConnectionConfig | undefined {
    const connections = store.list();
    if (connections.length === 0) return;
    const activeId = getActiveConnectionId();
    const active = activeId ? connections.find((c) => c.id === activeId) : undefined;
    if (active) return active;
    return connections[0];
  }

  function updateSqlStatus(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      sqlStatus.hide();
      return;
    }
    const doc = editor.document;
    const isSql = doc.languageId === "sql" || doc.fileName.toLowerCase().endsWith(".sql");
    if (!isSql) {
      sqlStatus.hide();
      return;
    }

    const connections = store.list();
    const fileCtx = !doc.isUntitled ? getSqlFileContext(doc.uri) : undefined;
    const active = getActiveConnection();
    const selectedConn = fileCtx?.connectionId
      ? connections.find((c) => c.id === fileCtx.connectionId)
      : undefined;
    const effectiveConn = selectedConn ?? active;
    const effectiveDb = fileCtx?.database ?? effectiveConn?.database;

    if (!effectiveConn) {
      sqlStatus.text = "$(database) More Connect: No connection";
      sqlStatus.tooltip = "Select a connection for this SQL file";
      sqlStatus.command = "moreConnect.selectConnectionForSql";
      sqlStatus.show();
      return;
    }

    const dbPart = effectiveDb ? ` / ${effectiveDb}` : "";
    sqlStatus.text = `$(database) ${effectiveConn.name}${dbPart}`;
    sqlStatus.tooltip = `SQL context\nConnection: ${effectiveConn.name}\nDatabase: ${effectiveDb ?? "(default)"}\n\nClick to change connection.`;
    sqlStatus.command = "moreConnect.selectConnectionForSql";
    sqlStatus.show();
  }

  async function runSqlFileOnActiveConnection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (editor.document.isUntitled) {
      vscode.window.showInformationMessage("Save the file as .sql first.");
      return;
    }
    if (!editor.document.fileName.toLowerCase().endsWith(".sql")) {
      vscode.window.showInformationMessage("Open a .sql file to run.");
      return;
    }
    const sql = editor.document.getText();
    if (!sql.trim()) return;

    const fileCtx = getSqlFileContext(editor.document.uri);
    const connections = store.list();
    const fileConnection = fileCtx?.connectionId
      ? connections.find((c) => c.id === fileCtx.connectionId)
      : undefined;
    const config = fileConnection ?? getActiveConnection() ?? pickConnectedOrAnyConnection();
    if (!config) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }
    try {
      const effectiveConfig = fileCtx?.database ? { ...config, database: fileCtx.database } : config;
      await runQuery(effectiveConfig, sql);
      await setSqlFileContext(editor.document.uri, { connectionId: effectiveConfig.id, database: effectiveConfig.database });
    } catch (e) {
      vscode.window.showErrorMessage(`Query failed: ${(e as Error).message}`);
    }
  }

  async function runSqlFromEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const isSql = doc.languageId === "sql" || doc.fileName.toLowerCase().endsWith(".sql");
    if (!isSql) return;

    const selection = editor.selection;
    const sql = selection.isEmpty
      ? sqlStatementAtCursor(doc, selection.active) || doc.lineAt(selection.active.line).text
      : doc.getText(selection);
    if (!sql.trim()) return;

    const fileCtx = !doc.isUntitled ? getSqlFileContext(doc.uri) : undefined;
    const connections = store.list();
    const fileConnection = fileCtx?.connectionId
      ? connections.find((c) => c.id === fileCtx.connectionId)
      : undefined;
    const config = fileConnection ?? getActiveConnection() ?? pickConnectedOrAnyConnection();
    if (!config) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }
    try {
      const effectiveConfig = fileCtx?.database ? { ...config, database: fileCtx.database } : config;
      await runQuery(effectiveConfig, sql);
      if (!doc.isUntitled && doc.fileName.toLowerCase().endsWith(".sql")) {
        await setSqlFileContext(doc.uri, { connectionId: effectiveConfig.id, database: effectiveConfig.database });
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Query failed: ${(e as Error).message}`);
    }
  }

  async function selectConnectionForSqlFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (doc.languageId !== "sql" && !doc.fileName.toLowerCase().endsWith(".sql")) {
      vscode.window.showInformationMessage("Open a .sql document first.");
      return;
    }

    const connections = store.list();
    if (connections.length === 0) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }
    const existing = getSqlFileContext(doc.uri);
    const pick = await vscode.window.showQuickPick(
      connections.map((c) => ({
        label: c.name,
        description: `${c.type}@${c.host}:${c.port}`,
        picked: c.id === existing?.connectionId,
        value: c
      })),
      { title: "Select connection for this .sql file", matchOnDescription: true }
    );
    if (!pick) return;
    await setSqlFileContext(doc.uri, { connectionId: pick.value.id, database: existing?.database });
    vscode.window.showInformationMessage(`SQL file connection: ${pick.value.name}`);
  }

  async function selectDatabaseForSqlFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (doc.languageId !== "sql" && !doc.fileName.toLowerCase().endsWith(".sql")) {
      vscode.window.showInformationMessage("Open a .sql document first.");
      return;
    }

    const existing = getSqlFileContext(doc.uri);
    const connections = store.list();
    const config =
      (existing?.connectionId ? connections.find((c) => c.id === existing.connectionId) : undefined) ??
      getActiveConnection() ??
      pickConnectedOrAnyConnection();
    if (!config) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }

    try {
      const client = await getOrCreateClient(config);
      if (!(await ensureConnectedWithRetry(config, "listing databases"))) return;
      const dbs = await client.listDatabases();
      const pick = await vscode.window.showQuickPick(
        dbs.map((db) => ({ label: db, picked: db === (existing?.database ?? config.database) })),
        { title: `Select database for this .sql file (${config.name})` }
      );
      if (!pick) return;
      await setSqlFileContext(doc.uri, { connectionId: config.id, database: pick.label });
      vscode.window.showInformationMessage(`SQL file DB: ${pick.label}`);
    } catch (e) {
      vscode.window.showErrorMessage(`Database list failed: ${(e as Error).message}`);
    }
  }

  function toOracleStringLiteral(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
    if (typeof value === "boolean") return value ? "1" : "0";
    const s = String(value);
    return `'${s.replaceAll("'", "''")}'`;
  }

  function rewriteOracleSelectToIncludeRowid(sql: string): { rewritten: string; table: string } | undefined {
    const s = sql.replaceAll(/\s+/g, " ").trim().replaceAll(/;+\s*$/g, "");
    if (!/^select\b/i.test(s)) return;
    if (/\bjoin\b|,/.test(s.toLowerCase())) return;
    const m = s.match(/\bfrom\s+([a-zA-Z0-9_$#."]+)(?:\s+(?:where|order\s+by|group\s+by|fetch|offset|for)\b|$)/i);
    if (!m) return;
    const table = m[1];
    // Insert ROWID into SELECT list.
    const m2 = s.match(/^\s*select\s+(.*?)\s+from\s+/i);
    if (!m2) return;
    const selectList = m2[1];
    if (/\browid\b/i.test(selectList)) return;
    const rewritten = s.replace(/^\s*select\s+/i, "SELECT ROWID AS ROWID, ");
    return { rewritten, table };
  }

  async function handleResultsPanelMessage(msg: any): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "results.runSql") {
      const connectionId = String(msg.connectionId ?? "");
      const sql = String(msg.sql ?? "");
      const database = String(msg.database ?? "");
      const baseConfig = store.list().find((c) => c.id === connectionId);
      if (!baseConfig) {
        postResultsStatus("Unknown connection.");
        return;
      }
      const config = database ? { ...baseConfig, database } : baseConfig;
      if (!sql.trim()) {
        postResultsStatus("SQL is empty.");
        return;
      }
      postResultsStatus("Running...");
      try {
        await runQuery(config, sql);
        postResultsStatus("");
      } catch (e) {
        postResultsStatus(`Run failed: ${(e as Error).message}`);
      }
      return;
    }

    if (msg.type === "results.rerunWithRowid") {
      const connectionId = String(msg.connectionId ?? "");
      const sql = String(msg.sql ?? "");
      const config = store.list().find((c) => c.id === connectionId);
      if (!config) {
        postResultsStatus("Unknown connection.");
        return;
      }
      if (config.type !== "oracle") {
        postResultsStatus("Re-run editable is only implemented for Oracle.");
        return;
      }
      const rewritten = rewriteOracleSelectToIncludeRowid(sql);
      if (!rewritten) {
        postResultsStatus("Can't auto-enable editing for this query (needs single-table SELECT).");
        return;
      }
      postResultsStatus("Re-running...");
      try {
        await runQuery(config, rewritten.rewritten);
        postResultsStatus("");
      } catch (e) {
        postResultsStatus(`Re-run failed: ${(e as Error).message}`);
      }
      return;
    }

    if (msg.type === "results.updateCell") {
      const connectionId = String(msg.connectionId ?? "");
      const database = String(msg.database ?? "");
      const table = String(msg.table ?? "").trim();
      const rowid = String(msg.rowid ?? "").trim();
      const column = String(msg.column ?? "").trim();
      const value = msg.value ?? "";

      const baseConfig = store.list().find((c) => c.id === connectionId);
      if (!baseConfig) {
        postResultsStatus("Unknown connection.");
        return;
      }
      const config = database ? { ...baseConfig, database } : baseConfig;
      if (config.type !== "oracle") {
        postResultsStatus("Editing is only implemented for Oracle results.");
        return;
      }
      if (!table || !rowid || !column) {
        postResultsStatus("Missing edit context (table/rowid/column).");
        return;
      }

      const updateSql = `UPDATE ${table} SET ${column} = ${toOracleStringLiteral(value)} WHERE ROWID = ${toOracleStringLiteral(
        rowid
      )}`;
      try {
        if (!(await ensureConnectedWithRetry(config, "saving changes"))) {
          postResultsStatus("Canceled.");
          return;
        }
        const client = await getOrCreateClient(config);
        await client.query(updateSql);
        postResultsStatus("Saved.");
        return;
      } catch (e) {
        postResultsStatus(`Save failed: ${(e as Error).message}`);
        return;
      }
    }
  }

  async function createNewSqlFromContext(): Promise<void> {
    const name =
      (await vscode.window.showInputBox({
        title: "New SQL name",
        prompt: "Name to show in Saved SQL list",
        ignoreFocusOut: true
      })) ?? "";
    if (!name.trim()) return;

    const doc = await vscode.workspace.openTextDocument({
      language: "sql",
      content: `-- ${name.trim()}\n\n`
    });
    await vscode.window.showTextDocument(doc, { preview: false });

    await upsertSavedSql({ id: randomUUID(), name: name.trim(), sql: doc.getText() });
  }

  async function saveActiveEditorSqlToGlobal(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (doc.languageId !== "sql" && !doc.fileName.toLowerCase().endsWith(".sql")) {
      vscode.window.showInformationMessage("Open a .sql document to save.");
      return;
    }
    const defaultName = doc.isUntitled ? "Untitled SQL" : vscode.workspace.asRelativePath(doc.uri, false);
    const name =
      (await vscode.window.showInputBox({
        title: "Save SQL",
        value: defaultName,
        ignoreFocusOut: true
      })) ?? "";
    if (!name.trim()) return;

    await upsertSavedSql({ id: randomUUID(), name: name.trim(), sql: doc.getText() });
    vscode.window.showInformationMessage(`Saved SQL: ${name.trim()}`);
  }

  function inferDefaultSqlNameFromEditor(doc: vscode.TextDocument): string {
    const first = doc.lineCount > 0 ? doc.lineAt(0).text.trim() : "";
    const m = first.match(/^--\s*(.+)$/);
    if (m?.[1]?.trim()) return m[1].trim();
    if (!doc.isUntitled) return vscode.workspace.asRelativePath(doc.uri, false);
    return "Untitled SQL";
  }

  async function addSqlFavoriteFromEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (doc.languageId !== "sql" && !doc.fileName.toLowerCase().endsWith(".sql")) {
      vscode.window.showInformationMessage("Open a .sql document first.");
      return;
    }

    const connections = store.list();
    const fileCtx = !doc.isUntitled ? getSqlFileContext(doc.uri) : undefined;
    const active = getActiveConnection();
    const selectedConn = fileCtx?.connectionId ? connections.find((c) => c.id === fileCtx.connectionId) : undefined;
    const effectiveConn = selectedConn ?? active ?? pickConnectedOrAnyConnection();
    if (!effectiveConn) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }
    const effectiveDb = fileCtx?.database ?? effectiveConn.database ?? "";
    if (!effectiveDb) {
      vscode.window.showInformationMessage("Select a database for this .sql first.");
      return;
    }

    const name =
      (await vscode.window.showInputBox({
        title: "Add SQL to favorites",
        value: inferDefaultSqlNameFromEditor(doc),
        ignoreFocusOut: true
      })) ?? "";
    if (!name.trim()) return;

    await upsertSavedSql({
      id: randomUUID(),
      name: name.trim(),
      sql: doc.getText(),
      connectionId: effectiveConn.id,
      database: effectiveDb,
      favorite: true
    });
    view.refresh();
    vscode.window.showInformationMessage(`Added to favorites: ${name.trim()} (${effectiveConn.name} / ${effectiveDb})`);
  }

  async function openSavedSqlPicker(): Promise<void> {
    const all = listSavedSql();
    if (all.length === 0) {
      vscode.window.showInformationMessage("No saved SQL yet.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((s) => ({
        label: s.name,
        description: new Date(s.updatedAt).toLocaleString(),
        detail: s.sql.trim().slice(0, 160).replaceAll(/\s+/g, " "),
        value: s
      })),
      { title: "Saved SQL", matchOnDescription: true, matchOnDetail: true }
    );
    if (!pick) return;
    const doc = await vscode.workspace.openTextDocument({ language: "sql", content: pick.value.sql });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async function showDatabaseInfo(node?: ExplorerNode): Promise<void> {
    if (!node || node.kind !== "database") return;
    const config = store.list().find((c) => c.id === node.connectionId);
    if (!config) return;
    const effectiveConfig = { ...config, database: node.database };
    try {
      const sql = effectiveConfig.type === "postgres"
        ? `SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_catalog = current_database()
  AND table_schema NOT IN ('pg_catalog','information_schema')
ORDER BY table_schema, table_name;`
        : `SELECT TABLE_SCHEMA as table_schema, TABLE_NAME as table_name, TABLE_TYPE as table_type
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${quoteStringMysql(node.database)}
ORDER BY TABLE_NAME;`;
      const result = await (await getOrCreateClient(effectiveConfig)).query(sql);
      const rows = result.rows as Array<Record<string, unknown>>;
      const body = [
        `<h1>Database: <code>${escapeHtml(node.database)}</code></h1>`,
        `<h2>Tables</h2>`,
        renderTable(["schema", "name", "type"], rows.map((r) => [
          String(r["table_schema"] ?? ""),
          String(r["table_name"] ?? ""),
          String(r["table_type"] ?? "")
        ]))
      ].join("\n");
      infoPanel.show(`DB Info: ${node.database}`, body);
    } catch (e) {
      vscode.window.showErrorMessage(`Info failed: ${(e as Error).message}`);
    }
  }

  async function showTableInfo(node?: ExplorerNode): Promise<void> {
    if (!node || node.kind !== "table") return;
    const config = store.list().find((c) => c.id === node.connectionId);
    if (!config) return;
    const effectiveConfig = { ...config, database: node.database };
    try {
      const tableName = node.schema ? `${node.schema}.${node.table}` : node.table;

      const columnsSql =
        effectiveConfig.type === "postgres"
          ? `SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = ${quoteStringPg(node.schema ?? "public")}
  AND table_name = ${quoteStringPg(node.table)}
ORDER BY ordinal_position;`
          : `SELECT COLUMN_NAME as column_name, COLUMN_TYPE as data_type, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ${quoteStringMysql(node.database)}
  AND TABLE_NAME = ${quoteStringMysql(node.table)}
ORDER BY ORDINAL_POSITION;`;

      const indexesSql =
        effectiveConfig.type === "postgres"
          ? `SELECT indexname as index_name, indexdef as index_def
FROM pg_indexes
WHERE schemaname = ${quoteStringPg(node.schema ?? "public")}
  AND tablename = ${quoteStringPg(node.table)}
ORDER BY indexname;`
          : `SELECT INDEX_NAME as index_name,
       NON_UNIQUE as non_unique,
       SEQ_IN_INDEX as seq_in_index,
       COLUMN_NAME as column_name,
       INDEX_TYPE as index_type
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ${quoteStringMysql(node.database)}
  AND TABLE_NAME = ${quoteStringMysql(node.table)}
ORDER BY INDEX_NAME, SEQ_IN_INDEX;`;

      const client = await getOrCreateClient(effectiveConfig, node.database);
      if (!client.isConnected) await connect(effectiveConfig);
      if (!client.isConnected) return;

      const [columnsRes, indexesRes] = await Promise.all([client.query(columnsSql), client.query(indexesSql)]);

      const columns = columnsRes.rows as Array<Record<string, unknown>>;
      const indexes = indexesRes.rows as Array<Record<string, unknown>>;

      const columnsTable = renderTable(
        ["name", "type", "nullable", "default"],
        columns.map((r) => [
          String(r["column_name"] ?? ""),
          String(r["data_type"] ?? ""),
          String(r["is_nullable"] ?? ""),
          String(r["column_default"] ?? "")
        ])
      );

      const indexesTable =
        effectiveConfig.type === "postgres"
          ? renderTable(
              ["name", "definition"],
              indexes.map((r) => [String(r["index_name"] ?? ""), String(r["index_def"] ?? "")])
            )
          : renderTable(
              ["name", "unique", "seq", "column", "type"],
              indexes.map((r) => [
                String(r["index_name"] ?? ""),
                String(Number(r["non_unique"] ?? 1) === 0 ? "YES" : "NO"),
                String(r["seq_in_index"] ?? ""),
                String(r["column_name"] ?? ""),
                String(r["index_type"] ?? "")
              ])
            );

      const body = [
        `<h1>Table: <code>${escapeHtml(node.database)}.${escapeHtml(tableName)}</code></h1>`,
        `<h2>Columns</h2>`,
        columnsTable,
        `<h2>Indexes</h2>`,
        indexesTable
      ].join("\n");

      infoPanel.show(`Table Info: ${tableName}`, body);
    } catch (e) {
      vscode.window.showErrorMessage(`Info failed: ${(e as Error).message}`);
    }
  }

  async function generateTableDdl(node?: ExplorerNode): Promise<void> {
    if (!node || node.kind !== "table") return;
    const config = store.list().find((c) => c.id === node.connectionId);
    if (!config) return;
    const effectiveConfig = { ...config, database: node.database };

    try {
      const client = await getOrCreateClient(effectiveConfig, node.database);
      if (!client.isConnected) await connect(effectiveConfig);
      if (!client.isConnected) return;

      let ddl = "";
      if (effectiveConfig.type === "postgres") {
        ddl = await buildPostgresTableDdl(client, node.schema ?? "public", node.table);
      } else {
        ddl = await fetchMysqlCreateTable(client, node.database, node.table);
      }

      const doc = await vscode.workspace.openTextDocument({ language: "sql", content: ddl.trimEnd() + "\n" });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      vscode.window.showErrorMessage(`DDL failed: ${(e as Error).message}`);
    }
  }

  async function previewRedisKey(config: ConnectionConfig, key: string): Promise<void> {
    const client = await getOrCreateClient(config);
    if (!client.isConnected) {
      await connect(config);
    }
    if (!client.isConnected) return;

    const trimmedKey = String(key ?? "");
    if (!trimmedKey) throw new Error("Redis key is empty");

    let type = "";
    let ttl = "";
    let result: QueryResult | undefined;

    // Prefer argv-based commands for Redis previews to avoid parsing edge cases.
    if (client instanceof RedisClient) {
      type = String(await client.sendCommand(["TYPE", trimmedKey])).trim().toLowerCase();
      ttl = String(await client.sendCommand(["TTL", trimmedKey]));

      const start = Date.now();
      if (type === "string") {
        const value = await client.sendCommand(["GET", trimmedKey]);
        result = {
          columns: ["value"],
          rows: [{ value }],
          rowCount: 1,
          durationMs: Date.now() - start
        };
      } else if (type === "hash") {
        const value = (await client.sendCommand(["HGETALL", trimmedKey])) as any;
        const rows: Array<Record<string, unknown>> = [];
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i += 2) rows.push({ field: value[i], value: value[i + 1] });
        }
        result = { columns: ["field", "value"], rows, rowCount: rows.length, durationMs: Date.now() - start };
      } else if (type === "list") {
        const value = (await client.sendCommand(["LRANGE", trimmedKey, "0", "200"])) as any;
        const list = Array.isArray(value) ? value : [];
        const rows = list.map((v, i) => ({ index: i, value: v }));
        result = { columns: ["index", "value"], rows, rowCount: rows.length, durationMs: Date.now() - start };
      } else if (type === "set") {
        const value = (await client.sendCommand(["SSCAN", trimmedKey, "0", "COUNT", "200"])) as any;
        const members = Array.isArray(value?.[1]) ? value[1] : [];
        const rows = members.map((v: any) => ({ member: v }));
        result = { columns: ["member"], rows, rowCount: rows.length, durationMs: Date.now() - start };
      } else if (type === "zset") {
        const value = (await client.sendCommand(["ZRANGE", trimmedKey, "0", "200", "WITHSCORES"])) as any;
        const rows: Array<Record<string, unknown>> = [];
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i += 2) rows.push({ member: value[i], score: value[i + 1] });
        }
        result = { columns: ["member", "score"], rows, rowCount: rows.length, durationMs: Date.now() - start };
      } else if (type === "stream") {
        const value = await client.sendCommand(["XRANGE", trimmedKey, "-", "+", "COUNT", "50"]);
        result = {
          columns: ["value"],
          rows: [{ value: stringifyValue(value) }],
          rowCount: 1,
          durationMs: Date.now() - start
        };
      } else if (type === "none" || !type) {
        result = { columns: ["message"], rows: [{ message: "Key not found" }], rowCount: 1, durationMs: 0 };
      } else {
        result = { columns: ["message"], rows: [{ message: `Unsupported type: ${type}` }], rowCount: 1, durationMs: 0 };
      }
    } else {
      const typeRes = await client.query(`TYPE ${escapeRedisArg(trimmedKey)}`);
      type = String((typeRes.rows?.[0] as any)?.value ?? "").trim().toLowerCase();

      const ttlRes = await client.query(`TTL ${escapeRedisArg(trimmedKey)}`);
      ttl = String((ttlRes.rows?.[0] as any)?.value ?? "");

      if (type === "string") {
        result = await client.query(`GET ${escapeRedisArg(trimmedKey)}`);
      } else if (type === "hash") {
        const raw = await client.query(`HGETALL ${escapeRedisArg(trimmedKey)}`);
        const parsed = safeJsonParseArray((raw.rows?.[0] as any)?.value);
        const rows: Array<Record<string, unknown>> = [];
        for (let i = 0; i < parsed.length; i += 2) rows.push({ field: parsed[i], value: parsed[i + 1] });
        result = { columns: ["field", "value"], rows, rowCount: rows.length, durationMs: raw.durationMs };
      } else if (type === "list") {
        const raw = await client.query(`LRANGE ${escapeRedisArg(trimmedKey)} 0 200`);
        const parsed = safeJsonParseArray((raw.rows?.[0] as any)?.value);
        const rows = parsed.map((v, i) => ({ index: i, value: v }));
        result = { columns: ["index", "value"], rows, rowCount: rows.length, durationMs: raw.durationMs };
      } else if (type === "set") {
        const raw = await client.query(`SSCAN ${escapeRedisArg(trimmedKey)} 0 COUNT 200`);
        const parsed = safeJsonParseArray((raw.rows?.[0] as any)?.value);
        const members = Array.isArray(parsed?.[1]) ? parsed[1] : [];
        const rows = members.map((v) => ({ member: v }));
        result = { columns: ["member"], rows, rowCount: rows.length, durationMs: raw.durationMs };
      } else if (type === "zset") {
        const raw = await client.query(`ZRANGE ${escapeRedisArg(trimmedKey)} 0 200 WITHSCORES`);
        const parsed = safeJsonParseArray((raw.rows?.[0] as any)?.value);
        const rows: Array<Record<string, unknown>> = [];
        for (let i = 0; i < parsed.length; i += 2) rows.push({ member: parsed[i], score: parsed[i + 1] });
        result = { columns: ["member", "score"], rows, rowCount: rows.length, durationMs: raw.durationMs };
      } else if (type === "stream") {
        result = await client.query(`XRANGE ${escapeRedisArg(trimmedKey)} - + COUNT 50`);
      } else if (type === "none" || !type) {
        result = { columns: ["message"], rows: [{ message: "Key not found" }], rowCount: 1, durationMs: 0 };
      } else {
        result = { columns: ["message"], rows: [{ message: `Unsupported type: ${type}` }], rowCount: 1, durationMs: 0 };
      }
    }

    const metaRow = { key, type, ttl };
    const metaResult: QueryResult = {
      columns: ["key", "type", "ttl"],
      rows: [metaRow],
      rowCount: 1,
      durationMs: 0
    };

    resultsPanel.show(config, `-- Redis key preview\n-- DB=${config.database ?? "0"}\n-- ${key}`, metaResult);
    // Show actual data in same panel by immediately overwriting with the data result
    resultsPanel.show(config, `-- Redis key: ${key}\n-- type=${type}, ttl=${ttl}\n`, result);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.refreshConnections", () => view.refresh()),

    vscode.commands.registerCommand("moreConnect.showStoragePaths", async () => {
      const drivers = vscode.Uri.joinPath(context.globalStorageUri, "drivers");
      const info = [
        `globalStorageUri: ${context.globalStorageUri.fsPath}`,
        `driversDir: ${drivers.fsPath}`,
        `connectionsFolderUri(setting): ${store.getFolderUri()?.fsPath ?? "(not set; using VS Code globalState)"}`,
        `connectionsFile(if set): ${
          store.getFolderUri()
            ? vscode.Uri.joinPath(store.getFolderUri()!, "more-connect-connections.json").fsPath
            : "(n/a)"
        }`
      ].join("\n");

      const choice = await vscode.window.showInformationMessage(info, "Copy", "Open globalStorage");
      if (choice === "Copy") {
        await vscode.env.clipboard.writeText(info);
      } else if (choice === "Open globalStorage") {
        await vscode.commands.executeCommand("revealFileInOS", context.globalStorageUri);
      }
    }),

    vscode.commands.registerCommand("moreConnect.setConnectionsStorageFolder", async () => {
      const pick = await vscode.window.showOpenDialog({
        title: "Select folder to store connection info",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Use this folder"
      });
      if (!pick?.[0]) return;
      await store.setFolderUri(pick[0]);
      await sshStore.setFolderUri(pick[0]);
      vscode.window.showInformationMessage(
        `Connection storage: ${vscode.Uri.joinPath(pick[0], "more-connect-connections.json").fsPath}`
      );
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.openSshTerminal", async (node?: ExplorerNode) => {
      const conn = node?.kind === "ssh" ? node.conn : undefined;
      if (!conn) return;
      const term = vscode.window.createTerminal({
        name: `SSH: ${conn.name}`,
        // Open the terminal in the editor area (본문창) instead of the panel.
        location: { viewColumn: vscode.ViewColumn.Active }
      });
      term.show(false);
      term.sendText(`ssh ${conn.target}`, true);
    }),

    vscode.commands.registerCommand("moreConnect.importSshConfig", async () => {
      const text = await readUserSshConfigText();
      if (!text.trim()) {
        vscode.window.showInformationMessage("No ~/.ssh/config found (or empty).");
        return;
      }
      const imported = sshConnectionsFromConfig(parseSshConfig(text));
      if (imported.length === 0) {
        vscode.window.showInformationMessage("No concrete Host entries found in ~/.ssh/config.");
        return;
      }

      const existing = sshStore.list();
      const existingTargets = new Set(existing.map((c) => c.target));
      const next = [...existing];
      let added = 0;
      for (const c of imported) {
        if (existingTargets.has(c.target)) continue;
        // Convert deterministic id to persisted unique id.
        next.push({ ...c, id: randomUUID() });
        added++;
      }
      await sshStore.saveAll(next);
      view.refresh();
      vscode.window.showInformationMessage(`Imported SSH hosts: +${added}`);
    }),

    vscode.commands.registerCommand("moreConnect.addSshConnection", async () => {
      const target = await vscode.window.showInputBox({
        title: "Add SSH connection",
        prompt: "Enter SSH target (e.g. my-alias, user@host, host -p 2222)",
        ignoreFocusOut: true
      });
      if (!target?.trim()) return;
      const name = await vscode.window.showInputBox({
        title: "Connection name",
        prompt: "Display name in the SSH view",
        value: target.trim(),
        ignoreFocusOut: true
      });
      if (!name?.trim()) return;
      const next = [...sshStore.list(), { id: randomUUID(), name: name.trim(), target: target.trim() }];
      await sshStore.saveAll(next);
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.editSshConnection", async (node?: ExplorerNode) => {
      const conn = node?.kind === "ssh" ? node.conn : undefined;
      if (!conn) return;

      const target = await vscode.window.showInputBox({
        title: `Edit SSH connection: ${conn.name}`,
        prompt: "SSH target (e.g. my-alias, user@host, host -p 2222)",
        value: conn.target,
        ignoreFocusOut: true
      });
      if (target === undefined) return;

      const name = await vscode.window.showInputBox({
        title: `Edit SSH connection: ${conn.name}`,
        prompt: "Display name in the SSH view",
        value: conn.name,
        ignoreFocusOut: true
      });
      if (name === undefined) return;

      const updated = { ...conn, name: name.trim() || conn.name, target: target.trim() || conn.target };
      await sshStore.saveAll(sshStore.list().map((c) => (c.id === conn.id ? updated : c)));
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeSshConnection", async (node?: ExplorerNode) => {
      const conn = node?.kind === "ssh" ? node.conn : undefined;
      if (!conn) return;
      await sshStore.saveAll(sshStore.list().filter((c) => c.id !== conn.id));
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.addConnection", async () => {
      const created = await promptConnectionConfig();
      if (!created) return;
      const { config, password, sshPassword } = created;
      const all = store.list();
      await store.saveAll([...all, config]);
      if (!getActiveConnectionId()) await setActiveConnectionId(config.id);
      if (password !== undefined && password.trim().length > 0) {
        await context.secrets.store(`${SECRET_PREFIX}${config.id}`, password);
        // eslint-disable-next-line no-console
        console.log("[more-connect] stored db password (wizard)", { id: config.id });
      }
      if (sshPassword !== undefined && sshPassword !== "")
        await context.secrets.store(`${SSH_SECRET_PREFIX}${config.id}`, sshPassword);
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.testConnectionFromWizard", async (payload: any) => {
      try {
        const { config, password, sshPassword } = (await promptConnectionConfigFromPayload(payload)) ?? {};
        if (!config) return;
        await testConnection(config, password, sshPassword);
      } catch (e) {
        vscode.window.showErrorMessage(`Test failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.editConnection", async (node?: ExplorerNode) => {
      const config = node && node.kind === "connection" ? node.config : pickConnectedOrAnyConnection();
      if (!config) return;
      const edited = await promptConnectionConfig(config);
      if (!edited) return;
      const { config: updated, password, sshPassword, resetPassword } = edited;
      await disconnect(config);

      if (resetPassword) await context.secrets.delete(`${SECRET_PREFIX}${updated.id}`);
      if (password !== undefined && password.trim().length > 0) {
        await context.secrets.store(`${SECRET_PREFIX}${updated.id}`, password);
      }
      if (resetPassword) await context.secrets.delete(`${SSH_SECRET_PREFIX}${updated.id}`);
      if (sshPassword !== undefined && sshPassword !== "") {
        await context.secrets.store(`${SSH_SECRET_PREFIX}${updated.id}`, sshPassword);
      }

      const all = store.list().map((c) => (c.id === updated.id ? updated : c));
      await store.saveAll(all);
      // eslint-disable-next-line no-console
      console.log("[more-connect] saved edited connection", {
        id: updated.id,
        storageFolder: store.getFolderUri()?.fsPath,
        file: store.getFolderUri()
          ? vscode.Uri.joinPath(store.getFolderUri()!, "more-connect-connections.json").fsPath
          : undefined
      });
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.duplicateConnection", async (node?: ExplorerNode) => {
      const config = node && node.kind === "connection" ? node.config : pickConnectedOrAnyConnection();
      if (!config) return;

      const all = store.list();
      const baseName = `${config.name} (copy)`;
      let nextName = baseName;
      for (let i = 2; all.some((c) => c.name === nextName); i++) {
        nextName = `${baseName} ${i}`;
      }

      const nextId = randomUUID();
      const cloned: ConnectionConfig = { ...config, id: nextId, name: nextName };
      await store.saveAll([...all, cloned]);

      const existingPassword = await context.secrets.get(`${SECRET_PREFIX}${config.id}`);
      if (existingPassword) await context.secrets.store(`${SECRET_PREFIX}${cloned.id}`, existingPassword);
      const existingSshPassword = await context.secrets.get(`${SSH_SECRET_PREFIX}${config.id}`);
      if (existingSshPassword) await context.secrets.store(`${SSH_SECRET_PREFIX}${cloned.id}`, existingSshPassword);

      view.refresh();
      vscode.window.showInformationMessage(`Connection duplicated: ${cloned.name}`);
    }),

    vscode.commands.registerCommand("moreConnect.removeConnection", async (node?: ExplorerNode) => {
      const config = node && node.kind === "connection" ? node.config : undefined;
      if (!config) return;
      await disconnect(config);
      const key = `${SECRET_PREFIX}${config.id}`;
      await context.secrets.delete(key);
      await context.secrets.delete(`${SSH_SECRET_PREFIX}${config.id}`);
      await store.saveAll(store.list().filter((c) => c.id !== config.id));
      for (const k of clientsByKey.keys()) {
        if (k.startsWith(`${config.id}::`)) clientsByKey.delete(k);
      }
      if (getActiveConnectionId() === config.id) await setActiveConnectionId(undefined);
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.connect", async (node?: ExplorerNode) => {
      const config = node && node.kind === "connection" ? node.config : pickConnectedOrAnyConnection();
      if (!config) return;
      try {
        await connect(config);
        await setActiveConnectionId(config.id);
      } catch (e) {
        vscode.window.showErrorMessage(`Connect failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.disconnect", async (node?: ExplorerNode) => {
      const config = node && node.kind === "connection" ? node.config : pickConnectedOrAnyConnection();
      if (!config) return;
      try {
        await disconnect(config);
      } catch (e) {
        vscode.window.showErrorMessage(`Disconnect failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.setActiveConnection", async (node?: ExplorerNode) => {
      const config = node && node.kind === "connection" ? node.config : pickConnectedOrAnyConnection();
      if (!config) return;
      await setActiveConnectionId(config.id);
    }),

    vscode.commands.registerCommand("moreConnect.refreshSchema", async (node?: ExplorerNode) => {
      if (node?.kind === "connection") {
        view.refresh(node);
        return;
      }
      if (node?.kind === "database") {
        view.refresh(node);
        return;
      }
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.previewTable", async (node?: ExplorerNode) => {
      if (!node || node.kind !== "table") return;
      const config = store.list().find((c) => c.id === node.connectionId);
      if (!config) return;
      try {
        if (config.type === "redis") {
          await previewRedisKey({ ...config, database: node.database }, node.table);
          return;
        }
        const sql = buildSelectPreviewSql(config.type, node.database, node.table, node.schema);
        await runQuery({ ...config, database: node.database }, sql);
      } catch (e) {
        vscode.window.showErrorMessage(`Preview failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.runQuery", async (node?: ExplorerNode) => {
      const config =
        node?.kind === "connection"
          ? node.config
          : node?.kind === "database"
            ? store.list().find((c) => c.id === node.connectionId)
            : pickConnectedOrAnyConnection();
      if (!config) {
        vscode.window.showInformationMessage("No connections. Add one first.");
        return;
      }
      const effectiveConfig =
        node?.kind === "database" ? { ...config, database: node.database } : config;
      const sql = await vscode.window.showInputBox({
        title: `SQL to run on ${effectiveConfig.name}`,
        prompt: "Enter a SQL statement (single query recommended)",
        ignoreFocusOut: true
      });
      if (!sql?.trim()) return;
      try {
        await runQuery(effectiveConfig, sql);
      } catch (e) {
        vscode.window.showErrorMessage(`Query failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.runQueryFromEditor", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.selection;
      const sql = selection.isEmpty
        ? sqlStatementAtCursor(editor.document, selection.active) ||
          editor.document.lineAt(selection.active.line).text
        : editor.document.getText(selection);

      const config = pickConnectedOrAnyConnection();
      if (!config) {
        vscode.window.showInformationMessage("No connections. Add one first.");
        return;
      }
      if (!sql.trim()) return;
      try {
        await runQuery(config, sql);
      } catch (e) {
        vscode.window.showErrorMessage(`Query failed: ${(e as Error).message}`);
      }
    })
    ,
    vscode.commands.registerCommand("moreConnect.runSqlFile", runSqlFileOnActiveConnection),
    vscode.commands.registerCommand("moreConnect.runSqlFromEditor", runSqlFromEditor),
    vscode.commands.registerCommand("moreConnect.selectConnectionForSql", selectConnectionForSqlFile),
    vscode.commands.registerCommand("moreConnect.selectDatabaseForSql", selectDatabaseForSqlFile),
    vscode.commands.registerCommand("moreConnect.newSql", createNewSqlFromContext),
    vscode.commands.registerCommand("moreConnect.openSavedSql", openSavedSqlPicker),
    vscode.commands.registerCommand("moreConnect.saveSqlToGlobal", saveActiveEditorSqlToGlobal),
    vscode.commands.registerCommand("moreConnect.addSqlFavoriteFromEditor", addSqlFavoriteFromEditor),
    vscode.commands.registerCommand("moreConnect.showDatabaseInfo", showDatabaseInfo),
    vscode.commands.registerCommand("moreConnect.showTableInfo", showTableInfo),
    vscode.commands.registerCommand("moreConnect.generateTableDdl", generateTableDdl),
    vscode.commands.registerCommand("moreConnect.runFavoriteSql", async (node?: ExplorerNode) => {
      if (!node || (node as any).kind !== "sqlItem") return;
      const n = node as any as { connectionId: string; database: string; sql: string; name: string };
      const config = store.list().find((c) => c.id === n.connectionId);
      if (!config) return;
      try {
        await runQuery({ ...config, database: n.database }, n.sql);
      } catch (e) {
        vscode.window.showErrorMessage(`Query failed: ${(e as Error).message}`);
      }
    })
  );

  treeView.onDidChangeSelection(async (e) => {
    const first = e.selection[0];
    if (first?.kind === "connection") {
      await setActiveConnectionId(first.config.id);
    }
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateSqlStatus()),
    vscode.workspace.onDidCloseTextDocument(() => updateSqlStatus())
  );
  updateSqlStatus();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "sql" }, new (class implements vscode.CodeLensProvider {
      onDidChangeCodeLenses?: vscode.Event<void> | undefined;
      provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (document.isUntitled) return [];
        const fileCtx = getSqlFileContext(document.uri);
        const connections = store.list();
        const active = getActiveConnection();
        const selectedConn = fileCtx?.connectionId ? connections.find((c) => c.id === fileCtx.connectionId) : undefined;
        const effectiveConn = selectedConn ?? active;
        const effectiveDb = fileCtx?.database ?? effectiveConn?.database ?? "";
        const pos = new vscode.Range(0, 0, 0, 0);
        const label = effectiveConn
          ? `$(database) ${effectiveConn.name}${effectiveDb ? ` / ${effectiveDb}` : ""}`
          : "$(database) More Connect: No connection";
        return [
          new vscode.CodeLens(pos, { title: label, command: "moreConnect.selectConnectionForSql" }),
          new vscode.CodeLens(pos, { title: "$(star) Add to favorites", command: "moreConnect.addSqlFavoriteFromEditor" }),
          new vscode.CodeLens(pos, { title: "$(database) Select database", command: "moreConnect.selectDatabaseForSql" })
        ];
      }
    })())
  );
}

export async function deactivate() {}

function logStoragePaths(output: vscode.OutputChannel, context: vscode.ExtensionContext, store: ConnectionStore): void {
  // Avoid noisy logs on activation; keep this for troubleshooting only.
  // Enable by launching VS Code Extension Host with env `MORE_CONNECT_DEBUG=1`.
  if (process.env.MORE_CONNECT_DEBUG !== "1") return;
  const drivers = vscode.Uri.joinPath(context.globalStorageUri, "drivers");
  const connectionsFolder = store.getFolderUri();
  const lines = [
    `[storage] globalStorageUri=${context.globalStorageUri.fsPath}`,
    `[storage] driversDir=${drivers.fsPath}`,
    `[storage] connectionsFolderUri=${connectionsFolder?.fsPath ?? "(not set; using VS Code globalState)"}`,
    `[storage] connectionsFile=${connectionsFolder ? vscode.Uri.joinPath(connectionsFolder, "more-connect-connections.json").fsPath : "(n/a)"}`
  ];
  for (const l of lines) output.appendLine(l);
}

function createGlobalStorageModuleLoader(driversDirFsPath: string): OptionalModuleLoader {
  const base = driversDirFsPath.endsWith("/") ? driversDirFsPath : `${driversDirFsPath}/`;
  const requireFromDrivers = createRequire(`${base}package.json`);
  return {
    require: (id: string) => {
      try {
        // Prefer modules installed into globalStorage/drivers/node_modules
        return requireFromDrivers(id);
      } catch {
        // Fallback to extension bundled deps (if any)
        // eslint-disable-next-line no-eval
        const req = (0, eval)("require") as (s: string) => any;
        return req(id);
      }
    }
  };
}

async function showMissingDriverHelp(
  context: vscode.ExtensionContext,
  driversDirFsPath: string,
  message: string
): Promise<void> {
  const driver = message.split(":")[1]?.trim() || "driver";
  const cmd = `npm i --prefix "${driversDirFsPath}" ${driver}`;
  const choice = await vscode.window.showErrorMessage(
    `Missing driver "${driver}". Install it into this extension's global storage:\n${cmd}\nThen reload VS Code.`,
    "Copy install command",
    "Open global storage folder"
  );
  if (choice === "Copy install command") {
    await vscode.env.clipboard.writeText(cmd);
  } else if (choice === "Open global storage folder") {
    await vscode.commands.executeCommand("revealFileInOS", context.globalStorageUri);
  }
}

function quoteIdentPg(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteIdentMysql(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

function quoteIdentOracle(name: string): string {
  // Defensive: strip control characters that can trigger ORA-00911 in generated SQL.
  // Also strip common invisible separators (NBSP, ZWSP/ZWNJ/ZWJ, BOM).
  const cleaned = name.replaceAll(/[\u0000-\u001F\u007F\u00A0\u200B-\u200D\uFEFF]/g, "").trim();
  return `"${cleaned.replaceAll('"', '""')}"`;
}

function quoteStringPg(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteStringMysql(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function buildSelectPreviewSql(type: DbType, database: string, table: string, schema?: string): string {
  if (type === "postgres") {
    const qTable = schema ? `${quoteIdentPg(schema)}.${quoteIdentPg(table)}` : quoteIdentPg(table);
    return `SELECT * FROM ${qTable} LIMIT 200;`;
  }
  if (type === "oracle") {
    const owner = (schema ?? database ?? "").trim();
    const qTable = owner ? `${quoteIdentOracle(owner)}.${quoteIdentOracle(table)}` : quoteIdentOracle(table);
    // Oracle driver rejects trailing semicolons; keep it statement-only.
    // Use ROWNUM for broad compatibility (works pre-12c too).
    return `SELECT * FROM ${qTable} WHERE ROWNUM <= 200`;
  }
  const qDb = quoteIdentMysql(database);
  const qTable = quoteIdentMysql(table);
  return `SELECT * FROM ${qDb}.${qTable} LIMIT 200;`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeRedisArg(s: string): string {
  // Redis CLI-like escaping: quote if needed.
  if (!s.includes(" ") && !s.includes("\t") && !s.includes("\n") && !s.includes('"')) return s;
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sqlStatementAtCursor(doc: vscode.TextDocument, pos: vscode.Position): string {
  const text = doc.getText();
  if (!text.trim()) return "";
  const offset = doc.offsetAt(pos);
  const safeOffset = Math.max(0, Math.min(offset, text.length));

  const before = text.lastIndexOf(";", Math.max(0, safeOffset - 1));
  const start = before === -1 ? 0 : before + 1;
  const after = text.indexOf(";", safeOffset);
  const end = after === -1 ? text.length : after;

  return text.slice(start, end).trim();
}

function safeJsonParseArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchMysqlCreateTable(client: DbClient, database: string, table: string): Promise<string> {
  const sql = `SHOW CREATE TABLE ${quoteIdentMysql(database)}.${quoteIdentMysql(table)};`;
  const result = await client.query(sql);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const create =
    (row?.["Create Table"] as string | undefined) ??
    (row?.["Create Table"] as string | undefined) ??
    (Object.values(row ?? {}).find((v) => typeof v === "string" && String(v).includes("CREATE TABLE")) as
      | string
      | undefined);
  if (!create) throw new Error("Could not read CREATE TABLE output.");
  return create.endsWith(";") ? create : `${create};`;
}

async function buildPostgresTableDdl(client: DbClient, schema: string, table: string): Promise<string> {
  const columnsSql = `SELECT column_name, data_type, is_nullable, column_default, udt_name, character_maximum_length, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = ${quoteStringPg(schema)} AND table_name = ${quoteStringPg(table)}
ORDER BY ordinal_position;`;

  const pkSql = `SELECT kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = ${quoteStringPg(schema)}
  AND tc.table_name = ${quoteStringPg(table)}
  AND tc.constraint_type = 'PRIMARY KEY'
ORDER BY kcu.ordinal_position;`;

  const uniquesSql = `SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = ${quoteStringPg(schema)}
  AND tc.table_name = ${quoteStringPg(table)}
  AND tc.constraint_type = 'UNIQUE'
ORDER BY tc.constraint_name, kcu.ordinal_position;`;

  const fksSql = `SELECT tc.constraint_name,
       kcu.column_name,
       ccu.table_schema AS foreign_table_schema,
       ccu.table_name AS foreign_table_name,
       ccu.column_name AS foreign_column_name,
       kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.table_schema = tc.table_schema
WHERE tc.table_schema = ${quoteStringPg(schema)}
  AND tc.table_name = ${quoteStringPg(table)}
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.constraint_name, kcu.ordinal_position;`;

  const [columnsRes, pkRes, uniqRes, fkRes] = await Promise.all([
    client.query(columnsSql),
    client.query(pkSql),
    client.query(uniquesSql),
    client.query(fksSql)
  ]);

  const columns = columnsRes.rows as Array<Record<string, unknown>>;
  if (columns.length === 0) throw new Error("Table not found (no columns).");

  const pkCols = (pkRes.rows as Array<Record<string, unknown>>).map((r) => String(r["column_name"] ?? ""));

  const uniquesRows = uniqRes.rows as Array<Record<string, unknown>>;
  const uniqueByName = new Map<string, Array<{ col: string; pos: number }>>();
  for (const r of uniquesRows) {
    const name = String(r["constraint_name"] ?? "");
    const col = String(r["column_name"] ?? "");
    const pos = Number(r["ordinal_position"] ?? 0);
    const arr = uniqueByName.get(name) ?? [];
    arr.push({ col, pos });
    uniqueByName.set(name, arr);
  }

  const fkRows = fkRes.rows as Array<Record<string, unknown>>;
  const fkByName = new Map<
    string,
    Array<{ col: string; pos: number; refSchema: string; refTable: string; refCol: string }>
  >();
  for (const r of fkRows) {
    const name = String(r["constraint_name"] ?? "");
    const col = String(r["column_name"] ?? "");
    const pos = Number(r["ordinal_position"] ?? 0);
    const refSchema = String(r["foreign_table_schema"] ?? "");
    const refTable = String(r["foreign_table_name"] ?? "");
    const refCol = String(r["foreign_column_name"] ?? "");
    const arr = fkByName.get(name) ?? [];
    arr.push({ col, pos, refSchema, refTable, refCol });
    fkByName.set(name, arr);
  }

  const lines: string[] = [];
  lines.push(`CREATE TABLE ${quoteIdentPg(schema)}.${quoteIdentPg(table)} (`);

  const colLines = columns.map((c) => {
    const name = String(c["column_name"] ?? "");
    const dataType = String(c["data_type"] ?? "");
    const udt = String(c["udt_name"] ?? "");
    const charLen = c["character_maximum_length"];
    const numPrec = c["numeric_precision"];
    const numScale = c["numeric_scale"];

    let typeSql = dataType;
    if (dataType === "character varying" && typeof charLen === "number") typeSql = `varchar(${charLen})`;
    if (dataType === "character" && typeof charLen === "number") typeSql = `char(${charLen})`;
    if (dataType === "numeric" && typeof numPrec === "number") {
      typeSql =
        typeof numScale === "number" ? `numeric(${numPrec},${numScale})` : `numeric(${numPrec})`;
    }
    if (dataType === "USER-DEFINED" && udt) typeSql = udt;

    const nullable = String(c["is_nullable"] ?? "YES") === "NO" ? " NOT NULL" : "";
    const def = c["column_default"];
    const defSql = def ? ` DEFAULT ${String(def)}` : "";
    return `  ${quoteIdentPg(name)} ${typeSql}${defSql}${nullable}`;
  });

  const constraintLines: string[] = [];
  if (pkCols.length) {
    constraintLines.push(`  PRIMARY KEY (${pkCols.map(quoteIdentPg).join(", ")})`);
  }
  for (const [name, cols] of uniqueByName.entries()) {
    const sorted = [...cols].sort((a, b) => a.pos - b.pos).map((x) => quoteIdentPg(x.col)).join(", ");
    if (sorted) constraintLines.push(`  CONSTRAINT ${quoteIdentPg(name)} UNIQUE (${sorted})`);
  }
  for (const [name, cols] of fkByName.entries()) {
    const sorted = [...cols].sort((a, b) => a.pos - b.pos);
    const localCols = sorted.map((x) => quoteIdentPg(x.col)).join(", ");
    const ref = sorted[0];
    const refCols = sorted.map((x) => quoteIdentPg(x.refCol)).join(", ");
    if (localCols && ref?.refTable) {
      constraintLines.push(
        `  CONSTRAINT ${quoteIdentPg(name)} FOREIGN KEY (${localCols}) REFERENCES ${quoteIdentPg(ref.refSchema)}.${quoteIdentPg(ref.refTable)} (${refCols})`
      );
    }
  }

  const allInner = [...colLines, ...constraintLines].map((l, i, arr) => (i === arr.length - 1 ? l : `${l},`));
  lines.push(...allInner);
  lines.push(");");
  return lines.join("\n");
}
