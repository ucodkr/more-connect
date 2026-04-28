import * as vscode from "vscode";
import type { DbClient } from "../db/client";
import { createClient, type OptionalModuleLoader } from "../db/factory";
import type { TunnelManager } from "../ssh/tunnelManager";
import type { ConnectionConfig } from "../types";
import { TimeoutError, withTimeout } from "../utils/withTimeout";
import { showMissingDriverHelp } from "./runtime";

type RefreshableView = {
  refresh(): void;
};

type CreateDbRuntimeDeps = {
  context: vscode.ExtensionContext;
  driverDirFsPath: string;
  moduleLoader: OptionalModuleLoader;
  tunnels: TunnelManager;
  view: RefreshableView;
  onDidUseDatabase?: (connectionId: string, database: string) => void;
};

type EnsureConnectedOptions = {
  autoReconnect?: boolean;
};

export type DbRuntime = ReturnType<typeof createDbRuntime>;

export function createDbRuntime(deps: CreateDbRuntimeDeps) {
  const clientsByKey = new Map<string, DbClient>();

  function clientKey(config: ConnectionConfig, databaseOverride?: string): string {
    const db = databaseOverride ?? config.database ?? "";
    return `${config.id}::${db}`;
  }

  function getConnectionTimeoutMs(): number {
    const v = vscode.workspace.getConfiguration("moreConnect").get<number>("connectionTimeoutMs", 15000);
    if (!Number.isFinite(v) || v <= 0) return 15000;
    return Math.min(Math.max(Math.trunc(v), 1000), 300000);
  }

  async function getOrCreateClient(config: ConnectionConfig, databaseOverride?: string): Promise<DbClient> {
    const key = clientKey(config, databaseOverride);
    const existing = clientsByKey.get(key);
    if (existing) return existing;
    const client = createClient({ ...config, database: databaseOverride ?? config.database }, deps.moduleLoader);
    clientsByKey.set(key, client);
    return client;
  }

  async function ensurePassword(config: ConnectionConfig): Promise<string | undefined> {
    if (config.type === "sqlite") return "";
    const key = `moreConnect.password.${config.id}`;
    const existing = await deps.context.secrets.get(key);
    if (existing !== undefined) return existing;
    if (config.type === "redis") return "";

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

  async function ensureSshPassword(config: ConnectionConfig): Promise<string | undefined> {
    if (!config.sshEnabled) return;
    const key = `moreConnect.sshPassword.${config.id}`;
    const existing = await deps.context.secrets.get(key);
    if (existing !== undefined) return existing;

    const password = await vscode.window.showInputBox({
      title: `SSH Password for ${config.name} (optional)`,
      password: true,
      ignoreFocusOut: true
    });
    if (password === undefined) return;
    if (password.trim().length === 0) return "";
    await deps.context.secrets.store(key, password);
    return password;
  }

  async function connect(config: ConnectionConfig): Promise<void> {
    const timeoutMs = getConnectionTimeoutMs();
    if (config.sshEnabled) {
      const sshPw = await ensureSshPassword(config);
      if (sshPw === undefined) return;
      try {
        const forwarded = await deps.tunnels.ensureTunnel(config, sshPw, timeoutMs);
        if (forwarded) {
          config = { ...config, host: forwarded.host, port: forwarded.port };
        }
      } catch (e) {
        const err = e as Error;
        if (err.message?.startsWith("Missing driver:")) {
          await showMissingDriverHelp(deps.context, deps.driverDirFsPath, err.message);
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
      await withTimeout(
        client.connect(password),
        timeoutMs,
        `Connection timed out after ${timeoutMs}ms (check host/port/credentials).`
      );
    } catch (e) {
      const err = e as Error;
      if (err.message?.startsWith("Missing driver:")) {
        await showMissingDriverHelp(deps.context, deps.driverDirFsPath, err.message);
        return;
      }
      try {
        await disconnect(config);
      } catch {}
      if (err instanceof TimeoutError) throw new Error(err.message);
      throw e;
    }

    deps.view.refresh();
  }

  async function testConnection(
    config: ConnectionConfig,
    password: string | undefined,
    sshPassword: string | undefined
  ): Promise<void> {
    const timeoutMs = getConnectionTimeoutMs();
    let effective = config;

    if (effective.sshEnabled) {
      try {
        const forwarded = await deps.tunnels.ensureTunnel(effective, sshPassword, timeoutMs);
        if (forwarded) effective = { ...effective, host: forwarded.host, port: forwarded.port };
      } catch (e) {
        const err = e as Error;
        if (err.message?.startsWith("Missing driver:")) {
          await showMissingDriverHelp(deps.context, deps.driverDirFsPath, err.message);
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
      await withTimeout(
        client.connect(pw),
        timeoutMs,
        `Connection timed out after ${timeoutMs}ms (check host/port/credentials).`
      );
      if (effective.type === "postgres") await client.query("SELECT 1;");
      else if (effective.type === "mysql" || effective.type === "mariadb") await client.query("SELECT 1;");
      else if (effective.type === "sqlite") await client.query("SELECT 1;");
      else if (effective.type === "oracle") await client.query("SELECT 1 FROM DUAL");
      else if (effective.type === "redis") await client.query("PING");
      vscode.window.showInformationMessage("Connection OK.");
    } catch (e) {
      const err = e as Error;
      if (err.message?.startsWith("Missing driver:")) {
        await showMissingDriverHelp(deps.context, deps.driverDirFsPath, err.message);
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
    for (const key of keys) clientsByKey.delete(key);
    try {
      await deps.tunnels.closeTunnel(config.id);
    } catch {}
    deps.view.refresh();
  }

  function isLikelyDisconnectedError(err: unknown): boolean {
    const msg = String((err as { message?: unknown } | undefined)?.message ?? err ?? "").toLowerCase();
    return (
      msg.includes("not connected") ||
      msg.includes("connection terminated") ||
      msg.includes("connection lost") ||
      msg.includes("econnreset") ||
      msg.includes("server closed the connection") ||
      msg.includes("dpi-1010") ||
      msg.includes("ora-03114") ||
      msg.includes("ora-03113") ||
      msg.includes("ora-00028") ||
      msg.includes("protocol_connection_lost") ||
      msg.includes("cannot enqueue query") ||
      msg.includes("client has encountered a connection error")
    );
  }

  async function pingClient(client: DbClient, config: ConnectionConfig): Promise<void> {
    if (config.type === "postgres") await client.query("SELECT 1;");
    else if (config.type === "mysql" || config.type === "mariadb") await client.query("SELECT 1;");
    else if (config.type === "sqlite") await client.query("SELECT 1;");
    else if (config.type === "oracle") await client.query("SELECT 1 FROM DUAL");
    else if (config.type === "redis") await client.query("PING");
  }

  async function ensureConnected(
    config: ConnectionConfig,
    actionLabel: string,
    options?: EnsureConnectedOptions
  ): Promise<boolean> {
    const autoReconnect = options?.autoReconnect ?? true;
    const client = await getOrCreateClient(config);
    if (!client.isConnected) {
      await connect(config);
      return client.isConnected;
    }

    try {
      await pingClient(client, config);
      return true;
    } catch (e) {
      if (!isLikelyDisconnectedError(e)) throw e;
      if (!autoReconnect) return false;
      try {
        await disconnect(config);
      } catch {}
      await connect(config);
      const reconnected = await getOrCreateClient(config);
      if (!reconnected.isConnected) return false;
      vscode.window.showInformationMessage(`Reconnected automatically before ${actionLabel}.`);
      return true;
    }
  }

  async function runQuery(config: ConnectionConfig, sql: string): Promise<DbClient> {
    const ready = await ensureConnected(config, "running SQL", { autoReconnect: true });
    if (!ready) throw new Error("Connection is not available.");
    const client = await getOrCreateClient(config);
    if (config.database) deps.onDidUseDatabase?.(config.id, config.database);
    await client.query(sql);
    return client;
  }

  async function executeQuery<T>(config: ConnectionConfig, sql: string): Promise<T> {
    const ready = await ensureConnected(config, "running SQL", { autoReconnect: true });
    if (!ready) throw new Error("Connection is not available.");
    const client = await getOrCreateClient(config);
    if (config.database) deps.onDidUseDatabase?.(config.id, config.database);
    return (await client.query(sql)) as T;
  }

  async function listDatabases(config: ConnectionConfig): Promise<string[]> {
    const ready = await ensureConnected(config, "loading databases", { autoReconnect: true });
    if (!ready) return [];
    const client = await getOrCreateClient(config);
    return await client.listDatabases();
  }

  async function listTables(
    config: ConnectionConfig,
    database: string
  ): Promise<Array<{ name: string; schema?: string; type?: string }>> {
    const effective = { ...config, database };
    const ready = await ensureConnected(effective, `loading tables for ${database}`, { autoReconnect: true });
    if (!ready) return [];
    const client = await getOrCreateClient(effective);
    return await client.listTables(database);
  }

  function isConnected(id: string): boolean {
    for (const [key, client] of clientsByKey.entries()) {
      if (key.startsWith(`${id}::`) && client.isConnected) return true;
    }
    return false;
  }

  function clearConnectionClients(connectionId: string): void {
    for (const key of clientsByKey.keys()) {
      if (key.startsWith(`${connectionId}::`)) clientsByKey.delete(key);
    }
  }

  return {
    getOrCreateClient,
    connect,
    testConnection,
    disconnect,
    ensureConnected,
    runQuery,
    executeQuery,
    listDatabases,
    listTables,
    isConnected,
    isLikelyDisconnectedError,
    clearConnectionClients
  };
}
