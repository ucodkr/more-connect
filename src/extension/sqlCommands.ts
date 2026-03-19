import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { RedisClient } from "../db/redisClient";
import {
  buildPostgresTableDdl,
  buildSelectPreviewSql,
  escapeHtml,
  escapeRedisArg,
  fetchMysqlCreateTable,
  quoteStringMysql,
  quoteStringPg,
  renderTable,
  safeJsonParseArray,
  sqlStatementAtCursor,
  stringifyValue
} from "./sqlUtils";
import type { InfoPanel } from "../ui/infoPanel";
import type { ExplorerNode } from "../ui/explorerView";
import type { ResultsPanel } from "../ui/resultsPanel";
import type { ConnectionStore } from "../storage";
import type { ConnectionConfig, QueryResult } from "../types";
import type { SavedSql, SqlFileContext } from "./state";
import type { DbRuntime } from "./dbRuntime";

type SqlControllerDeps = {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  output: vscode.OutputChannel;
  resultsPanel: ResultsPanel;
  infoPanel: InfoPanel;
  view: { refresh(node?: ExplorerNode): void };
  sqlStatus: vscode.StatusBarItem;
  dbRuntime: DbRuntime;
  getActiveConnectionId(): string | undefined;
  getActiveDatabaseForConnection(connectionId: string | undefined): string | undefined;
  setActiveDatabaseForConnection(connectionId: string, database: string): void;
  getSqlFileContext(uri: vscode.Uri): SqlFileContext | undefined;
  setSqlFileContext(uri: vscode.Uri, next: Omit<SqlFileContext, "updatedAt">): Promise<void>;
  listSavedSql(): SavedSql[];
  upsertSavedSql(entry: Omit<SavedSql, "updatedAt"> & { updatedAt?: number }): Promise<void>;
};

const execFileAsync = promisify(execFile);
const MYSQL_DOCKER_IMAGE = "mariadb:11";

export function createSqlController(deps: SqlControllerDeps) {
  function postResultsStatus(text: string): void {
    deps.resultsPanel.postMessage({ type: "results.status", text });
  }

  async function runQuery(config: ConnectionConfig, sql: string): Promise<QueryResult> {
    deps.output.show(true);
    deps.output.appendLine(`\n[${new Date().toISOString()}] ${config.name} - Running query...`);
    deps.output.appendLine(sql);

    const ready = await deps.dbRuntime.ensureConnected(config, "running SQL", { autoReconnect: true });
    if (!ready) throw new Error("Connection is not available.");
    const client = await deps.dbRuntime.getOrCreateClient(config);

    if (config.database) deps.setActiveDatabaseForConnection(config.id, config.database);
    const result = await client.query(sql);
    deps.output.appendLine(`Result: rows=${result.rowCount ?? result.rows.length}, duration=${result.durationMs}ms`);
    deps.resultsPanel.show(config, sql, result);
    return result;
  }

  function getActiveConnection(): ConnectionConfig | undefined {
    const connections = deps.store.list();
    const activeId = deps.getActiveConnectionId();
    return activeId ? connections.find((c) => c.id === activeId) : undefined;
  }

  function pickConnectedOrAnyConnection(): ConnectionConfig | undefined {
    const connections = deps.store.list();
    if (connections.length === 0) return;
    const activeId = deps.getActiveConnectionId();
    const active = activeId ? connections.find((c) => c.id === activeId) : undefined;
    if (active) return active;
    return connections[0];
  }

  function updateSqlStatus(): void {
    const sqlStatus = deps.sqlStatus;
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

    const connections = deps.store.list();
    const fileCtx = deps.getSqlFileContext(doc.uri);
    const active = getActiveConnection();
    const selectedConn = fileCtx?.connectionId
      ? connections.find((c) => c.id === fileCtx.connectionId)
      : undefined;
    const effectiveConn = selectedConn ?? active;
    const effectiveDb =
      fileCtx?.database ?? effectiveConn?.database ?? deps.getActiveDatabaseForConnection(effectiveConn?.id);

    if (!effectiveConn) {
      sqlStatus.text = "$(database) More Connect: No connection";
      sqlStatus.tooltip = "Select a connection for this SQL file";
      sqlStatus.show();
      return;
    }

    const dbPart = effectiveDb ? ` / ${effectiveDb}` : "";
    sqlStatus.text = `$(database) ${effectiveConn.name}${dbPart}`;
    sqlStatus.tooltip = `SQL context\nConnection: ${effectiveConn.name}\nDatabase: ${effectiveDb ?? "(default)"}\n\nClick to change connection.`;
    sqlStatus.show();
  }

  function getMysqlDatabaseContext(node?: ExplorerNode): { config: ConnectionConfig; database: string } | undefined {
    if (!node || node.kind !== "database") return;
    const config = deps.store.list().find((c) => c.id === node.connectionId);
    if (!config || (config.type !== "mysql" && config.type !== "mariadb")) return;
    return { config, database: node.database };
  }

  function getMysqlExportContext(
    node?: ExplorerNode
  ): { config: ConnectionConfig; database: string; table?: string; schema?: string } | undefined {
    if (!node) return;
    if (node.kind === "database") {
      const config = deps.store.list().find((c) => c.id === node.connectionId);
      if (!config || (config.type !== "mysql" && config.type !== "mariadb")) return;
      return { config, database: node.database };
    }
    if (node.kind === "table") {
      const config = deps.store.list().find((c) => c.id === node.connectionId);
      if (!config || (config.type !== "mysql" && config.type !== "mariadb")) return;
      return { config, database: node.database, table: node.table, schema: node.schema };
    }
    return;
  }

  async function ensureConnectionPassword(config: ConnectionConfig): Promise<string | undefined> {
    const key = `moreConnect.password.${config.id}`;
    const existing = await deps.context.secrets.get(key);
    if (existing !== undefined) return existing;

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
    await deps.context.secrets.store(key, password);
    return password;
  }

  async function ensureDockerInstalled(): Promise<boolean> {
    try {
      const { stdout, stderr } = await execFileAsync("docker", ["--version"], {
        env: process.env,
        maxBuffer: 1024 * 1024
      });
      deps.output.appendLine(`[Docker] ${String(stdout || stderr).trim() || "docker --version OK"}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Docker is not installed or not available in PATH: ${message}`);
      return false;
    }
  }

  async function spawnDockerToFile(args: string[], password: string, targetPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", args, {
        env: { ...process.env, MYSQL_PWD: password },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stderrChunks: Buffer[] = [];
      let exitCode: number | null = null;
      let pipeDone = false;

      const finish = () => {
        if (exitCode === null || !pipeDone) return;
        if (exitCode === 0) {
          resolve();
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(stderr || `docker exited with code ${exitCode}`));
      };

      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
      child.on("error", reject);
      pipeline(child.stdout, createWriteStream(targetPath))
        .then(() => {
          pipeDone = true;
          finish();
        })
        .catch(reject);
      child.on("close", (code) => {
        exitCode = code;
        finish();
      });
    });
  }

  async function spawnDockerFromFile(args: string[], password: string, sourcePath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", args, {
        env: { ...process.env, MYSQL_PWD: password },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stderrChunks: Buffer[] = [];
      const stdoutChunks: Buffer[] = [];
      let stdinDone = false;
      let exitCode: number | null = null;

      const finish = () => {
        if (exitCode === null || !stdinDone) return;
        if (exitCode === 0) {
          resolve();
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
        reject(new Error(stderr || stdout || `docker exited with code ${exitCode}`));
      };

      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
      child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
      child.on("error", reject);
      pipeline(createReadStream(sourcePath), child.stdin)
        .then(() => {
          stdinDone = true;
          finish();
        })
        .catch(reject);
      child.on("close", (code) => {
        exitCode = code;
        finish();
      });
    });
  }

  function localTimestampForFilename(): string {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}-${hh}-${mi}-${ss}`;
  }

  function buildDefaultDumpName(config: ConnectionConfig, database: string, table?: string): string {
    const stamp = localTimestampForFilename();
    const safeName = `${config.name}-${database}${table ? `-${table}` : ""}`
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
    return `${safeName}-${stamp}.sql`;
  }

  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
  }

  function resolveDockerMysqlHost(host: string): string {
    if (process.platform === "linux") return host;
    return isLoopbackHost(host) ? "host.docker.internal" : host;
  }

  function dockerNetworkArgs(): string[] {
    return process.platform === "linux" ? ["--network", "host"] : [];
  }

  function dockerMysqlPasswordEnvArgs(): string[] {
    // Pass through MYSQL_PWD from the docker CLI process into the container
    // without exposing the actual password in command arguments or logs.
    return ["-e", "MYSQL_PWD"];
  }

  function dockerTimezoneEnvArgs(): string[] {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezone ? ["-e", `TZ=${timezone}`] : [];
  }

  async function withElapsedProgress<T>(
    title: string,
    run: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>
  ): Promise<T> {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false
      },
      async (progress) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
          progress.report({ message: `In progress... ${elapsedSec}s elapsed` });
        }, 1000);
        try {
          progress.report({ message: "Starting..." });
          return await run(progress);
        } finally {
          clearInterval(timer);
        }
      }
    );
  }

  async function exportMysqlDatabaseViaDocker(node?: ExplorerNode): Promise<void> {
    const ctx = getMysqlExportContext(node);
    if (!ctx) return;
    if (!(await ensureDockerInstalled())) return;

    const password = await ensureConnectionPassword(ctx.config);
    if (password === undefined) return;

    const targetLabel = ctx.table ? `${ctx.database}.${ctx.table}` : ctx.database;

    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const target = await vscode.window.showSaveDialog({
      title: `Export ${targetLabel} via Docker`,
      defaultUri: vscode.Uri.file(path.join(defaultDir, buildDefaultDumpName(ctx.config, ctx.database, ctx.table))),
      filters: { SQL: ["sql"], All: ["*"] },
      saveLabel: "Export"
    });
    if (!target) return;

    const ignoreTables = ctx.table
      ? []
      : (((await vscode.window.showInputBox({
            title: `Ignore tables for ${ctx.database} (optional)`,
            prompt: "Comma-separated fully qualified table names",
            placeHolder: `${ctx.database}.v_SOURCE_queue_group`,
            ignoreFocusOut: true
          })) ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean));

    const dockerHost = resolveDockerMysqlHost(ctx.config.host);
    const args = [
      "run",
      "--rm",
      ...dockerMysqlPasswordEnvArgs(),
      ...dockerTimezoneEnvArgs(),
      ...dockerNetworkArgs(),
      MYSQL_DOCKER_IMAGE,
      "mariadb-dump",
      "--skip-ssl",
      "--protocol=TCP",
      `-h${dockerHost}`,
      `-P${ctx.config.port}`,
      `-u${ctx.config.user}`,
      "--single-transaction",
      "--default-character-set=utf8mb4",
      ...ignoreTables.map((table) => `--ignore-table=${table}`),
      ctx.database,
      ...(ctx.table ? [ctx.table] : [])
    ];

    deps.output.show(true);
    deps.output.appendLine(`\n[${new Date().toISOString()}] Export via Docker: ${ctx.config.name}/${targetLabel}`);
    deps.output.appendLine(
      `[Docker] platform=${process.platform}, dbHost=${ctx.config.host}, dockerHost=${dockerHost}, tz=${
        Intl.DateTimeFormat().resolvedOptions().timeZone || "system"
      }`
    );
    deps.output.appendLine(`docker ${args.join(" ")}`);

    try {
      await withElapsedProgress(
        `Exporting ${targetLabel} via Docker`,
        async (progress) => {
          progress.report({ message: "Starting export..." });
          await spawnDockerToFile(args, password, target.fsPath);
          progress.report({ message: "Finalizing dump file..." });
        }
      );
      vscode.window.showInformationMessage(`Export completed: ${target.fsPath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Export failed: ${(error as Error).message}`);
    }
  }

  async function importMysqlDatabaseViaDocker(node?: ExplorerNode): Promise<void> {
    const ctx = getMysqlExportContext(node);
    if (!ctx) return;
    if (!(await ensureDockerInstalled())) return;

    const password = await ensureConnectionPassword(ctx.config);
    if (password === undefined) return;

    const targetLabel = ctx.table ? `${ctx.database}.${ctx.table}` : ctx.database;

    const dockerHost = resolveDockerMysqlHost(ctx.config.host);
    const source = await vscode.window.showOpenDialog({
      title: `Import ${targetLabel} via Docker`,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { SQL: ["sql"], All: ["*"] },
      openLabel: "Import"
    });
    if (!source?.[0]) return;

    const confirm = await vscode.window.showWarningMessage(
      ctx.table
        ? `Import ${source[0].fsPath} into ${ctx.config.name}/${targetLabel}? The SQL file should target only this table. Existing data may be overwritten.`
        : `Import ${source[0].fsPath} into ${ctx.config.name}/${ctx.database}? Existing data may be overwritten.`,
      { modal: true },
      "Import"
    );
    if (confirm !== "Import") return;

    const args = [
      "run",
      "--rm",
      "-i",
      ...dockerMysqlPasswordEnvArgs(),
      ...dockerTimezoneEnvArgs(),
      ...dockerNetworkArgs(),
      MYSQL_DOCKER_IMAGE,
      "mariadb",
      "--skip-ssl",
      "--protocol=TCP",
      `--host=${dockerHost}`,
      `--port=${ctx.config.port}`,
      `--user=${ctx.config.user}`,
      ctx.database
    ];

    deps.output.show(true);
    deps.output.appendLine(`\n[${new Date().toISOString()}] Import via Docker: ${ctx.config.name}/${targetLabel}`);
    deps.output.appendLine(
      `[Docker] platform=${process.platform}, dbHost=${ctx.config.host}, dockerHost=${dockerHost}, tz=${
        Intl.DateTimeFormat().resolvedOptions().timeZone || "system"
      }`
    );
    deps.output.appendLine(`docker ${args.join(" ")} < ${source[0].fsPath}`);

    try {
      await withElapsedProgress(
        `Importing ${targetLabel} via Docker`,
        async () => {
          await spawnDockerFromFile(args, password, source[0].fsPath);
        }
      );
      vscode.window.showInformationMessage(`Import completed: ${targetLabel}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Import failed: ${(error as Error).message}`);
    }
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

    const fileCtx = deps.getSqlFileContext(editor.document.uri);
    const connections = deps.store.list();
    const fileConnection = fileCtx?.connectionId
      ? connections.find((c) => c.id === fileCtx.connectionId)
      : undefined;
    const config = fileConnection ?? getActiveConnection() ?? pickConnectedOrAnyConnection();
    if (!config) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }

    try {
      const fallbackDb = deps.getActiveDatabaseForConnection(config.id);
      const effectiveDb = fileCtx?.database ?? config.database ?? fallbackDb;
      const effectiveConfig = effectiveDb ? { ...config, database: effectiveDb } : config;
      await runQuery(effectiveConfig, sql);
      await deps.setSqlFileContext(editor.document.uri, {
        connectionId: effectiveConfig.id,
        database: effectiveConfig.database
      });
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

    const fileCtx = deps.getSqlFileContext(doc.uri);
    const connections = deps.store.list();
    const fileConnection = fileCtx?.connectionId
      ? connections.find((c) => c.id === fileCtx.connectionId)
      : undefined;
    const config = fileConnection ?? getActiveConnection() ?? pickConnectedOrAnyConnection();
    if (!config) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }

    try {
      const fallbackDb = deps.getActiveDatabaseForConnection(config.id);
      const effectiveDb = fileCtx?.database ?? config.database ?? fallbackDb;
      const effectiveConfig = effectiveDb ? { ...config, database: effectiveDb } : config;
      await runQuery(effectiveConfig, sql);
      if (!doc.isUntitled && doc.fileName.toLowerCase().endsWith(".sql")) {
        await deps.setSqlFileContext(doc.uri, { connectionId: effectiveConfig.id, database: effectiveConfig.database });
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

    const connections = deps.store.list();
    if (connections.length === 0) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }

    const existing = deps.getSqlFileContext(doc.uri);
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
    await deps.setSqlFileContext(doc.uri, { connectionId: pick.value.id, database: existing?.database });
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

    const existing = deps.getSqlFileContext(doc.uri);
    const connections = deps.store.list();
    const config =
      (existing?.connectionId ? connections.find((c) => c.id === existing.connectionId) : undefined) ??
      getActiveConnection() ??
      pickConnectedOrAnyConnection();
    if (!config) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }

    try {
      const dbs = await deps.dbRuntime.listDatabases(config);
      const pick = await vscode.window.showQuickPick(
        dbs.map((db) => ({ label: db, picked: db === (existing?.database ?? config.database) })),
        { title: `Select database for this .sql file (${config.name})` }
      );
      if (!pick) return;
      await deps.setSqlFileContext(doc.uri, { connectionId: config.id, database: pick.label });
      deps.setActiveDatabaseForConnection(config.id, pick.label);
      vscode.window.showInformationMessage(`SQL file DB: ${pick.label}`);
    } catch (e) {
      vscode.window.showErrorMessage(`Database list failed: ${(e as Error).message}`);
    }
  }

  function toOracleStringLiteral(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
    if (typeof value === "boolean") return value ? "1" : "0";
    return `'${String(value).replaceAll("'", "''")}'`;
  }

  function rewriteOracleSelectToIncludeRowid(sql: string): { rewritten: string; table: string } | undefined {
    const s = sql.replaceAll(/\s+/g, " ").trim().replaceAll(/;+\s*$/g, "");
    if (!/^select\b/i.test(s)) return;
    if (/\bjoin\b|,/.test(s.toLowerCase())) return;
    const m = s.match(/\bfrom\s+([a-zA-Z0-9_$#."]+)(?:\s+(?:where|order\s+by|group\s+by|fetch|offset|for)\b|$)/i);
    if (!m) return;
    const table = m[1];
    const m2 = s.match(/^\s*select\s+(.*?)\s+from\s+/i);
    if (!m2) return;
    if (/\browid\b/i.test(m2[1])) return;
    return {
      rewritten: s.replace(/^\s*select\s+/i, "SELECT ROWID AS ROWID, "),
      table
    };
  }

  async function handleResultsPanelMessage(msg: any): Promise<void> {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "results.runSql") {
      const connectionId = String(msg.connectionId ?? "");
      const sql = String(msg.sql ?? "");
      const database = String(msg.database ?? "");
      const baseConfig = deps.store.list().find((c) => c.id === connectionId);
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
      const config = deps.store.list().find((c) => c.id === connectionId);
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

      const baseConfig = deps.store.list().find((c) => c.id === connectionId);
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
        const ready = await deps.dbRuntime.ensureConnected(config, "saving changes", { autoReconnect: true });
        if (!ready) {
          postResultsStatus("Canceled.");
          return;
        }
        const client = await deps.dbRuntime.getOrCreateClient(config);
        await client.query(updateSql);
        postResultsStatus("Saved.");
      } catch (e) {
        postResultsStatus(`Save failed: ${(e as Error).message}`);
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
    await deps.upsertSavedSql({ id: randomUUID(), name: name.trim(), sql: doc.getText() });
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

    await deps.upsertSavedSql({ id: randomUUID(), name: name.trim(), sql: doc.getText() });
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

    const connections = deps.store.list();
    const fileCtx = !doc.isUntitled ? deps.getSqlFileContext(doc.uri) : undefined;
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

    await deps.upsertSavedSql({
      id: randomUUID(),
      name: name.trim(),
      sql: doc.getText(),
      connectionId: effectiveConn.id,
      database: effectiveDb,
      favorite: true
    });
    deps.view.refresh();
    vscode.window.showInformationMessage(`Added to favorites: ${name.trim()} (${effectiveConn.name} / ${effectiveDb})`);
  }

  async function openSavedSqlPicker(): Promise<void> {
    const all = deps.listSavedSql();
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
    const config = deps.store.list().find((c) => c.id === node.connectionId);
    if (!config) return;
    const effectiveConfig = { ...config, database: node.database };

    try {
      const sql =
        effectiveConfig.type === "postgres"
          ? `SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_catalog = current_database()
  AND table_schema NOT IN ('pg_catalog','information_schema')
ORDER BY table_schema, table_name;`
          : `SELECT TABLE_SCHEMA as table_schema, TABLE_NAME as table_name, TABLE_TYPE as table_type
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${quoteStringMysql(node.database)}
ORDER BY TABLE_NAME;`;
      const ready = await deps.dbRuntime.ensureConnected(effectiveConfig, "loading database info", { autoReconnect: true });
      if (!ready) return;
      const client = await deps.dbRuntime.getOrCreateClient(effectiveConfig);
      const result = await client.query(sql);
      const rows = result.rows as Array<Record<string, unknown>>;
      const body = [
        `<h1>Database: <code>${escapeHtml(node.database)}</code></h1>`,
        `<h2>Tables</h2>`,
        renderTable(
          ["schema", "name", "type"],
          rows.map((r) => [
            String(r["table_schema"] ?? ""),
            String(r["table_name"] ?? ""),
            String(r["table_type"] ?? "")
          ])
        )
      ].join("\n");
      deps.infoPanel.show(`DB Info: ${node.database}`, body, {
        showRefreshButton: true,
        onRefresh: async () => {
          await showDatabaseInfo(node);
        }
      });
    } catch (e) {
      vscode.window.showErrorMessage(`Info failed: ${(e as Error).message}`);
    }
  }

  async function showTableInfo(node?: ExplorerNode): Promise<void> {
    if (!node || node.kind !== "table") return;
    const config = deps.store.list().find((c) => c.id === node.connectionId);
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
          : effectiveConfig.type === "sqlite"
            ? `SELECT name AS column_name,
       type AS data_type,
       CASE "notnull" WHEN 1 THEN 'NO' ELSE 'YES' END AS is_nullable,
       dflt_value AS column_default
FROM pragma_table_info(${quoteStringPg(node.table)})
ORDER BY cid;`
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
          : effectiveConfig.type === "sqlite"
            ? `SELECT name AS index_name,
       CASE "unique" WHEN 1 THEN 0 ELSE 1 END AS non_unique,
       origin AS index_type,
       partial
FROM pragma_index_list(${quoteStringPg(node.table)})
ORDER BY name;`
            : `SELECT INDEX_NAME as index_name,
       NON_UNIQUE as non_unique,
       SEQ_IN_INDEX as seq_in_index,
       COLUMN_NAME as column_name,
       INDEX_TYPE as index_type
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ${quoteStringMysql(node.database)}
  AND TABLE_NAME = ${quoteStringMysql(node.table)}
ORDER BY INDEX_NAME, SEQ_IN_INDEX;`;

      const ready = await deps.dbRuntime.ensureConnected(effectiveConfig, "loading table info", { autoReconnect: true });
      if (!ready) return;
      const client = await deps.dbRuntime.getOrCreateClient(effectiveConfig, node.database);

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
          : effectiveConfig.type === "sqlite"
            ? renderTable(
                ["name", "unique", "origin", "partial"],
                indexes.map((r) => [
                  String(r["index_name"] ?? ""),
                  String(Number(r["non_unique"] ?? 1) === 0 ? "YES" : "NO"),
                  String(r["index_type"] ?? ""),
                  String(Number(r["partial"] ?? 0) === 1 ? "YES" : "NO")
                ])
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
        "<h2>Columns</h2>",
        columnsTable,
        "<h2>Indexes</h2>",
        indexesTable
      ].join("\n");

      deps.infoPanel.show(`Table Info: ${tableName}`, body, {
        showRefreshButton: true,
        onRefresh: async () => {
          await showTableInfo(node);
        }
      });
    } catch (e) {
      vscode.window.showErrorMessage(`Info failed: ${(e as Error).message}`);
    }
  }

  async function generateTableDdl(node?: ExplorerNode): Promise<void> {
    if (!node || node.kind !== "table") return;
    const config = deps.store.list().find((c) => c.id === node.connectionId);
    if (!config) return;
    const effectiveConfig = { ...config, database: node.database };

    try {
      const ready = await deps.dbRuntime.ensureConnected(effectiveConfig, "generating DDL", { autoReconnect: true });
      if (!ready) return;
      const client = await deps.dbRuntime.getOrCreateClient(effectiveConfig, node.database);

      const ddl =
        effectiveConfig.type === "postgres"
          ? await buildPostgresTableDdl(client, node.schema ?? "public", node.table)
          : await fetchMysqlCreateTable(client, node.database, node.table);

      const doc = await vscode.workspace.openTextDocument({ language: "sql", content: `${ddl.trimEnd()}\n` });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      vscode.window.showErrorMessage(`DDL failed: ${(e as Error).message}`);
    }
  }

  async function previewRedisKey(config: ConnectionConfig, key: string): Promise<void> {
    const ready = await deps.dbRuntime.ensureConnected(config, "loading Redis key", { autoReconnect: true });
    if (!ready) return;

    const client = await deps.dbRuntime.getOrCreateClient(config);
    const trimmedKey = String(key ?? "");
    if (!trimmedKey) throw new Error("Redis key is empty");

    let type = "";
    let ttl = "";
    let result: QueryResult | undefined;

    if (client instanceof RedisClient) {
      type = String(await client.sendCommand(["TYPE", trimmedKey])).trim().toLowerCase();
      ttl = String(await client.sendCommand(["TTL", trimmedKey]));

      const start = Date.now();
      if (type === "string") {
        const value = await client.sendCommand(["GET", trimmedKey]);
        result = { columns: ["value"], rows: [{ value }], rowCount: 1, durationMs: Date.now() - start };
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
        result = { columns: ["value"], rows: [{ value: stringifyValue(value) }], rowCount: 1, durationMs: Date.now() - start };
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

    const metaResult: QueryResult = {
      columns: ["key", "type", "ttl"],
      rows: [{ key, type, ttl }],
      rowCount: 1,
      durationMs: 0
    };

    deps.resultsPanel.show(config, `-- Redis key preview\n-- DB=${config.database ?? "0"}\n-- ${key}`, metaResult);
    deps.resultsPanel.show(config, `-- Redis key: ${key}\n-- type=${type}, ttl=${ttl}\n`, result);
  }

  async function previewTable(node?: ExplorerNode): Promise<void> {
    if (!node || node.kind !== "table") return;
    const config = deps.store.list().find((c) => c.id === node.connectionId);
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
  }

  async function runPromptedQuery(node?: ExplorerNode): Promise<void> {
    const config =
      node?.kind === "connection"
        ? node.config
        : node?.kind === "database"
          ? deps.store.list().find((c) => c.id === node.connectionId)
          : pickConnectedOrAnyConnection();
    if (!config) {
      vscode.window.showInformationMessage("No connections. Add one first.");
      return;
    }

    const effectiveConfig = node?.kind === "database" ? { ...config, database: node.database } : config;
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
  }

  async function runQueryFromEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const isSql = doc.languageId === "sql" || doc.fileName.toLowerCase().endsWith(".sql");
    if (isSql) {
      await runSqlFromEditor();
      return;
    }

    const selection = editor.selection;
    const sql = selection.isEmpty
      ? sqlStatementAtCursor(doc, selection.active) || doc.lineAt(selection.active.line).text
      : doc.getText(selection);
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
  }

  async function runFavoriteSql(node?: ExplorerNode): Promise<void> {
    if (!node || node.kind !== "sqlItem") return;
    const config = deps.store.list().find((c) => c.id === node.connectionId);
    if (!config) return;

    try {
      await runQuery({ ...config, database: node.database }, node.sql);
    } catch (e) {
      vscode.window.showErrorMessage(`Query failed: ${(e as Error).message}`);
    }
  }

  function createCodeLensProvider(): vscode.CodeLensProvider {
    return new (class implements vscode.CodeLensProvider {
      public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (document.isUntitled) return [];
        const fileCtx = deps.getSqlFileContext(document.uri);
        const connections = deps.store.list();
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
    })();
  }

  return {
    updateSqlStatus,
    handleResultsPanelMessage,
    runSqlFileOnActiveConnection,
    runSqlFromEditor,
    selectConnectionForSqlFile,
    selectDatabaseForSqlFile,
    createNewSqlFromContext,
    openSavedSqlPicker,
    saveActiveEditorSqlToGlobal,
    addSqlFavoriteFromEditor,
    showDatabaseInfo,
    showTableInfo,
    generateTableDdl,
    exportMysqlDatabaseViaDocker,
    importMysqlDatabaseViaDocker,
    previewTable,
    runPromptedQuery,
    runQueryFromEditor,
    runFavoriteSql,
    createCodeLensProvider
  };
}
