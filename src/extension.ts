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

const SECRET_PREFIX = "moreConnect.password.";
const ACTIVE_CONNECTION_KEY = "moreConnect.activeConnectionId";
const SAVED_SQL_KEY = "moreConnect.savedSql.v1";
const SQL_FILE_CONTEXT_KEY = "moreConnect.sqlFileContext.v1";

type SavedSql = {
  id: string;
  name: string;
  sql: string;
  updatedAt: number;
};

type SqlFileContext = {
  connectionId?: string;
  database?: string;
  updatedAt: number;
};

export async function activate(context: vscode.ExtensionContext) {
  const store = new ConnectionStore(context.globalState);
  const output = vscode.window.createOutputChannel("More Connect");
  const resultsPanel = new ResultsPanel(context);
  const infoPanel = new InfoPanel(context);
  const connectionWizard = new ConnectionWizard(context);
  const sqlStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sqlStatus.name = "More Connect SQL Context";
  sqlStatus.command = "moreConnect.selectConnectionForSql";
  context.subscriptions.push(sqlStatus);

  const clientsByKey = new Map<string, DbClient>();
  const driverDir = vscode.Uri.joinPath(context.globalStorageUri, "drivers");
  const moduleLoader: OptionalModuleLoader = createGlobalStorageModuleLoader(driverDir.fsPath);

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
    const client = createClient({ ...config, database: databaseOverride ?? config.database }, moduleLoader);
    clientsByKey.set(key, client);
    return client;
  }

  async function promptConnectionConfig(existing?: ConnectionConfig): Promise<{
    config: ConnectionConfig;
    password?: string;
    resetPassword?: boolean;
  } | undefined> {
    const res = await connectionWizard.open(existing);
    if (res.kind !== "save") return;
    return { config: res.config, password: res.password, resetPassword: res.resetPassword };
  }

  async function ensurePassword(config: ConnectionConfig): Promise<string | undefined> {
    if (config.type === "sqlite") return "";
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
    const sql = selection.isEmpty ? doc.lineAt(selection.active.line).text : doc.getText(selection);
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
      if (!client.isConnected) await connect(config);
      if (!client.isConnected) return;
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

  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.refreshConnections", () => view.refresh()),

    vscode.commands.registerCommand("moreConnect.addConnection", async () => {
      const created = await promptConnectionConfig();
      if (!created) return;
      const { config, password } = created;
      const all = store.list();
      await store.saveAll([...all, config]);
      if (!getActiveConnectionId()) await setActiveConnectionId(config.id);
      if (password !== undefined) await context.secrets.store(`${SECRET_PREFIX}${config.id}`, password);
      view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.editConnection", async (node?: ExplorerNode) => {
      const config = node && node.kind === "connection" ? node.config : pickConnectedOrAnyConnection();
      if (!config) return;
      const edited = await promptConnectionConfig(config);
      if (!edited) return;
      const { config: updated, password, resetPassword } = edited;
      await disconnect(config);

      if (resetPassword) await context.secrets.delete(`${SECRET_PREFIX}${updated.id}`);
      if (password !== undefined && password !== "") {
        await context.secrets.store(`${SECRET_PREFIX}${updated.id}`, password);
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
    ,
    vscode.commands.registerCommand("moreConnect.runSqlFile", runSqlFileOnActiveConnection),
    vscode.commands.registerCommand("moreConnect.runSqlFromEditor", runSqlFromEditor),
    vscode.commands.registerCommand("moreConnect.selectConnectionForSql", selectConnectionForSqlFile),
    vscode.commands.registerCommand("moreConnect.selectDatabaseForSql", selectDatabaseForSqlFile),
    vscode.commands.registerCommand("moreConnect.newSql", createNewSqlFromContext),
    vscode.commands.registerCommand("moreConnect.openSavedSql", openSavedSqlPicker),
    vscode.commands.registerCommand("moreConnect.saveSqlToGlobal", saveActiveEditorSqlToGlobal),
    vscode.commands.registerCommand("moreConnect.showDatabaseInfo", showDatabaseInfo),
    vscode.commands.registerCommand("moreConnect.showTableInfo", showTableInfo),
    vscode.commands.registerCommand("moreConnect.generateTableDdl", generateTableDdl)
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
}

export async function deactivate() {}

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
