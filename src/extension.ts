import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ConnectionConfig, DbType } from "./types";
import { ConnectionStore } from "./storage";
import { createClient } from "./db/factory";
import type { DbClient } from "./db/client";
import { ResultsPanel } from "./ui/resultsPanel";
import { ExplorerView, type ExplorerNode } from "./ui/explorerView";

const SECRET_PREFIX = "moreConnect.password.";
const ACTIVE_CONNECTION_KEY = "moreConnect.activeConnectionId";

export async function activate(context: vscode.ExtensionContext) {
  const store = new ConnectionStore(context.globalState);
  const output = vscode.window.createOutputChannel("More Connect");
  const resultsPanel = new ResultsPanel(context);

  const clientsByKey = new Map<string, DbClient>();

  function getActiveConnectionId(): string | undefined {
    return context.globalState.get<string>(ACTIVE_CONNECTION_KEY);
  }

  async function setActiveConnectionId(id: string | undefined): Promise<void> {
    await context.globalState.update(ACTIVE_CONNECTION_KEY, id);
    view.refresh();
  }

  function clientKey(config: ConnectionConfig, databaseOverride?: string): string {
    const db = databaseOverride ?? config.database ?? "";
    return `${config.id}::${db}`;
  }

  const view = new ExplorerView({
    listConnections: () => store.list(),
    isConnected: (id) => {
      for (const [key, client] of clientsByKey.entries()) {
        if (key.startsWith(`${id}::`) && client.isConnected) return true;
      }
      return false;
    },
    getActiveConnectionId,
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

  const treeView = vscode.window.createTreeView("moreConnectConnections", { treeDataProvider: view });
  context.subscriptions.push(treeView, output);

  async function getOrCreateClient(config: ConnectionConfig, databaseOverride?: string): Promise<DbClient> {
    const key = clientKey(config, databaseOverride);
    const existing = clientsByKey.get(key);
    if (existing) return existing;
    const client = createClient({ ...config, database: databaseOverride ?? config.database });
    clientsByKey.set(key, client);
    return client;
  }

  async function promptConnectionType(): Promise<DbType | undefined> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "MySQL", value: "mysql" as const },
        { label: "MariaDB", value: "mariadb" as const },
        { label: "PostgreSQL", value: "postgres" as const }
      ],
      { title: "Database Type" }
    );
    return pick?.value;
  }

  async function promptConnectionConfig(existing?: ConnectionConfig): Promise<ConnectionConfig | undefined> {
    const type = existing?.type ?? (await promptConnectionType());
    if (!type) return;

    const name = await vscode.window.showInputBox({
      title: "Connection Name",
      value: existing?.name ?? `${type}-local`
    });
    if (!name) return;

    const host = await vscode.window.showInputBox({ title: "Host", value: existing?.host ?? "localhost" });
    if (!host) return;

    const defaultPort = type === "postgres" ? 5432 : 3306;
    const portStr = await vscode.window.showInputBox({
      title: "Port",
      value: String(existing?.port ?? defaultPort),
      validateInput: (s) => (Number.isFinite(Number(s)) ? undefined : "Port must be a number")
    });
    if (!portStr) return;
    const port = Number(portStr);

    const user = await vscode.window.showInputBox({ title: "User", value: existing?.user ?? "root" });
    if (!user) return;

    const database = await vscode.window.showInputBox({
      title: "Database (optional)",
      value: existing?.database ?? (type === "postgres" ? "postgres" : "")
    });

    const sslPick = await vscode.window.showQuickPick(
      [
        { label: "SSL: Off", value: false },
        { label: "SSL: On (rejectUnauthorized=false)", value: true }
      ],
      { title: "SSL" }
    );
    if (!sslPick) return;

    return {
      id: existing?.id ?? randomUUID(),
      name,
      type,
      host,
      port,
      user,
      database: database?.trim() ? database.trim() : undefined,
      ssl: sslPick.value
    };
  }

  async function ensurePassword(config: ConnectionConfig): Promise<string | undefined> {
    const key = `${SECRET_PREFIX}${config.id}`;
    const existing = await context.secrets.get(key);
    if (existing) return existing;

    const password = await vscode.window.showInputBox({
      title: `Password for ${config.name}`,
      password: true,
      ignoreFocusOut: true
    });
    if (password === undefined) return;
    await context.secrets.store(key, password);
    return password;
  }

  async function connect(config: ConnectionConfig): Promise<void> {
    const client = await getOrCreateClient(config);
    if (client.isConnected) return;
    const password = await ensurePassword(config);
    if (password === undefined) return;
    await client.connect(password);
    view.refresh();
  }

  async function disconnect(config: ConnectionConfig): Promise<void> {
    for (const [key, client] of clientsByKey.entries()) {
      if (key.startsWith(`${config.id}::`) && client.isConnected) {
        await client.disconnect();
      }
    }
    view.refresh();
  }

  async function runQuery(config: ConnectionConfig, sql: string): Promise<void> {
    const client = await getOrCreateClient(config);
    if (!client.isConnected) {
      await connect(config);
    }
    if (!client.isConnected) return;

    output.show(true);
    output.appendLine(`\n[${new Date().toISOString()}] ${config.name} — Running query...`);
    output.appendLine(sql);

    const result = await client.query(sql);
    output.appendLine(`Result: rows=${result.rowCount ?? result.rows.length}, duration=${result.durationMs}ms`);
    resultsPanel.show(config, sql, result);
  }

  function pickConnectedOrAnyConnection(): ConnectionConfig | undefined {
    const connections = store.list();
    if (connections.length === 0) return;
    const activeId = getActiveConnectionId();
    const active = activeId ? connections.find((c) => c.id === activeId) : undefined;
    if (active) return active;
    return connections[0];
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.refreshConnections", () => view.refresh()),

    vscode.commands.registerCommand("moreConnect.addConnection", async () => {
      const config = await promptConnectionConfig();
      if (!config) return;
      const all = store.list();
      await store.saveAll([...all, config]);
      if (!getActiveConnectionId()) await setActiveConnectionId(config.id);
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.editConnection", async (node?: ExplorerNode) => {
      const config = node && node.kind === "connection" ? node.config : pickConnectedOrAnyConnection();
      if (!config) return;
      const updated = await promptConnectionConfig(config);
      if (!updated) return;
      await disconnect(config);

      const resetPw = await vscode.window.showQuickPick(
        [
          { label: "Keep saved password", value: false },
          { label: "Reset saved password", value: true }
        ],
        { title: `Password for ${updated.name}` }
      );
      if (resetPw?.value) {
        await context.secrets.delete(`${SECRET_PREFIX}${updated.id}`);
      }

      const all = store.list().map((c) => (c.id === updated.id ? updated : c));
      await store.saveAll(all);
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeConnection", async (node?: ExplorerNode) => {
      const config = node && node.kind === "connection" ? node.config : undefined;
      if (!config) return;
      await disconnect(config);
      const key = `${SECRET_PREFIX}${config.id}`;
      await context.secrets.delete(key);
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
        ? editor.document.lineAt(selection.active.line).text
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
  );

  treeView.onDidChangeSelection(async (e) => {
    const first = e.selection[0];
    if (first?.kind === "connection") {
      await setActiveConnectionId(first.config.id);
    }
  });
}

export async function deactivate() {}

function quoteIdentPg(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteIdentMysql(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

function buildSelectPreviewSql(type: DbType, database: string, table: string, schema?: string): string {
  if (type === "postgres") {
    const qTable = schema ? `${quoteIdentPg(schema)}.${quoteIdentPg(table)}` : quoteIdentPg(table);
    return `SELECT * FROM ${qTable} LIMIT 200;`;
  }
  const qDb = quoteIdentMysql(database);
  const qTable = quoteIdentMysql(table);
  return `SELECT * FROM ${qDb}.${qTable} LIMIT 200;`;
}
