import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ConnectionConfig, QueryResult } from "./types";
import {
  listDockerContainers,
  listDockerImages,
  listDockerNetworks,
  listDockerVolumes,
} from "./docker/dockerClient";
import { DockerStore } from "./docker/dockerStore";
import { ConnectionStore } from "./storage";
import { createClient, type OptionalModuleLoader } from "./db/factory";
import type { DbClient } from "./db/client";
import { ResultsPanel } from "./ui/resultsPanel";
import { InfoPanel } from "./ui/infoPanel";
import { ConnectionWizard } from "./ui/connectionWizard";
import { ExplorerView, type ExplorerNode } from "./ui/explorerView";
import { OllamaChatPanel } from "./ui/ollamaChatPanel";
import { TunnelManager } from "./ssh/tunnelManager";
import { RedisClient } from "./db/redisClient";
import { SshStore } from "./ssh/sshStore";
import { TimeoutError, withTimeout } from "./utils/withTimeout";
import { WebLinkStore } from "./web/webLinkStore";
import { OllamaStore } from "./ollama/ollamaStore";
import { VsCodeFavoriteStore } from "./vscode/vscodeFavoriteStore";
import { RestViewProvider } from "./rest/viewProvider";
import { createOllamaSessionStore } from "./extension/ollamaUtils";
import { registerAppCommands } from "./extension/appCommands";
import { createOllamaController } from "./extension/ollamaController";
import { registerDockerCommands } from "./extension/dockerCommands";
import { registerOllamaCommands } from "./extension/ollamaCommands";
import { registerRestCommands } from "./extension/restCommands";
import { registerSshCommands } from "./extension/sshCommands";
import { registerVsCodeFavoriteCommands } from "./extension/vscodeFavoriteCommands";
import { registerWebCommands } from "./extension/webCommands";
import { createExtensionState, type SavedSql, type SqlFileContext } from "./extension/state";
import {
  currentWorkspaceToFavorite,
  normalizeHttpUrl,
  normalizeOllamaUrl,
  openInternalBrowser,
  pathToVsCodeFavorite,
  previewMarkdownFile,
  promptDockerHost,
  quoteShellArg
} from "./extension/browserUtils";
import { createGlobalStorageModuleLoader, logStoragePaths, showMissingDriverHelp } from "./extension/runtime";
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
} from "./extension/sqlUtils";

const SECRET_PREFIX = "moreConnect.password.";
const SSH_SECRET_PREFIX = "moreConnect.sshPassword.";
const ACTIVE_CONNECTION_KEY = "moreConnect.activeConnectionId";
const SAVED_SQL_KEY = "moreConnect.savedSql.v1";
const SQL_FILE_CONTEXT_KEY = "moreConnect.sqlFileContext.v1";
const OLLAMA_SESSIONS_KEY = "moreConnect.ollamaSessions.v1";
const EXPLORER_GROUP_STATE_KEY = "moreConnect.explorerGroupState.v1";

export async function activate(context: vscode.ExtensionContext) {
  const store = new ConnectionStore(context);
  await store.init(context.globalState);
  const sshStore = new SshStore(context);
  await sshStore.init();
  const webLinkStore = new WebLinkStore(context);
  await webLinkStore.init();
  const vsCodeFavoriteStore = new VsCodeFavoriteStore(context);
  await vsCodeFavoriteStore.init();
  const ollamaStore = new OllamaStore(context);
  await ollamaStore.init();
  const dockerStore = new DockerStore(context);
  await dockerStore.init();
  const restProvider = new RestViewProvider(context);
  const output = vscode.window.createOutputChannel("More Connect");
  let ollamaController: ReturnType<typeof createOllamaController>;
  const ollamaChatPanel = new OllamaChatPanel(context, async (panelKey, msg) => {
    await ollamaController.handleOllamaChatPanelMessage(panelKey, msg);
  });
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
  const extensionVersion = String(context.extension.packageJSON.version ?? "dev");

  // Ensure global storage folders exist (VS Code creates them lazily otherwise).
  try {
    await vscode.workspace.fs.createDirectory(driverDir);
  } catch {}

  const state = createExtensionState({
    globalState: context.globalState,
    activeConnectionKey: ACTIVE_CONNECTION_KEY,
    savedSqlKey: SAVED_SQL_KEY,
    sqlFileContextKey: SQL_FILE_CONTEXT_KEY,
    explorerGroupStateKey: EXPLORER_GROUP_STATE_KEY,
    onActiveConnectionChanged: () => {
      view.refresh();
      updateSqlStatus();
    },
    onSqlContextChanged: () => {
      updateSqlStatus();
    }
  });

  const {
    getActiveConnectionId,
    setActiveConnectionId,
    setActiveDatabaseForConnection,
    getActiveDatabaseForConnection,
    getExplorerGroupState,
    setExplorerGroupExpanded,
    getSqlFileContext,
    setSqlFileContext,
    listSavedSql,
    upsertSavedSql
  } = state;

  const ollamaSessionStore = createOllamaSessionStore({
    globalState: context.globalState,
    sessionsKey: OLLAMA_SESSIONS_KEY
  });
  const {
    listSessions: listOllamaSessions,
    saveSessions: saveOllamaSessions,
    upsertSession: upsertOllamaSession
  } = ollamaSessionStore;
  ollamaController = createOllamaController({
    ollamaStore,
    ollamaChatPanel,
    sessionStore: {
      listSessions: listOllamaSessions,
      saveSessions: saveOllamaSessions,
      upsertSession: upsertOllamaSession
    }
  });

  function clientKey(config: ConnectionConfig, databaseOverride?: string): string {
    const db = databaseOverride ?? config.database ?? "";
    return `${config.id}::${db}`;
  }

  const view = new ExplorerView({
    listConnections: () => store.list(),
    listSshConnections: () => sshStore.list(),
    listWebLinks: () => webLinkStore.list(),
    listDockerHosts: () => dockerStore.list(),
    listDockerContainers: async (host) => await listDockerContainers(host),
    listDockerImages: async (host) => await listDockerImages(host),
    listDockerVolumes: async (host) => await listDockerVolumes(host),
    listDockerNetworks: async (host) => await listDockerNetworks(host),
    listRestCollections: async () => await restProvider.listCollections(),
    listRestItems: async (collectionId, parentFolderId) => await restProvider.listItems(collectionId, parentFolderId),
    listVsCodeFavorites: () => vsCodeFavoriteStore.list(),
    listOllamaEndpoints: () => ollamaStore.list(),
    listOllamaModels: async (endpoint) => await ollamaController.fetchOllamaModels(endpoint),
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
    },
    isGroupExpanded: (group) => getExplorerGroupState()[group],
    getVersionLabel: () => `More Connect v${extensionVersion}`
  });
  registerAppCommands(context, {
    store,
    sshStore,
    webLinkStore,
    dockerStore,
    vsCodeFavoriteStore,
    ollamaStore,
    restProvider,
    view,
    extensionVersion
  });
  registerOllamaCommands(context, {
    ollamaStore,
    ollamaController,
    view,
    infoPanel,
    normalizeOllamaUrl,
    llmProviderLabel: (endpoint) => (endpoint.provider === "vllm" ? "vLLM" : "Ollama"),
    isOllamaProvider: (endpoint) => endpoint.provider !== "vllm",
    escapeHtml,
    renderTable
  });
  registerRestCommands(context, { restProvider });
  registerDockerCommands(context, {
    dockerStore,
    view,
    promptDockerHost,
    quoteShellArg
  });
  registerSshCommands(context, { sshStore, view });
  registerWebCommands(context, {
    webLinkStore,
    view,
    normalizeHttpUrl,
    openInternalBrowser,
    previewMarkdownFile
  });
  registerVsCodeFavoriteCommands(context, {
    vsCodeFavoriteStore,
    view,
    currentWorkspaceToFavorite,
    pathToVsCodeFavorite
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
          if (n.kind === "webLink") return { kind: "web", id: n.link.id };
          if (n.kind === "dockerHost") return { kind: "docker", id: n.host.id };
          if (n.kind === "restCollection") return { kind: "rest", id: n.collection.id };
          if (n.kind === "restFolder") return { kind: "restFolder", id: n.folder.id, collectionId: n.collectionId };
          if (n.kind === "restRequest") return { kind: "restRequest", id: n.request.id, collectionId: n.collectionId };
          if (n.kind === "vscodeFavorite") return { kind: "vscode", id: n.favorite.id };
          if (n.kind === "ollama") return { kind: "ollama", id: n.endpoint.id };
          return;
        })
        .filter(Boolean);
      if (items.length === 0) return;
      dataTransfer.set(DND_MIME, new vscode.DataTransferItem(JSON.stringify(items)));
    },
    handleDrop: async (target, dataTransfer) => {
      const raw = dataTransfer.get(DND_MIME)?.value;
      if (typeof raw !== "string") return;
      let dragged: Array<
        | { kind: "db" | "ssh" | "web" | "docker" | "rest" | "vscode" | "ollama"; id: string }
        | { kind: "restFolder" | "restRequest"; id: string; collectionId: string }
      > = [];
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
              : target?.kind === "webLink"
                ? "web"
                : target?.kind === "dockerHost"
                  ? "docker"
                : target?.kind === "restCollection"
                  ? "rest"
                : target?.kind === "restFolder"
                  ? "restFolder"
                : target?.kind === "restRequest"
                  ? "restRequest"
                : target?.kind === "vscodeFavorite"
                  ? "vscode"
                : target?.kind === "ollama"
                  ? "ollama"
              : undefined;
      const restFolderDrop =
        dragKind === "restFolder" &&
        (target?.kind === "restCollection" || target?.kind === "restFolder");
      const restRequestDrop =
        dragKind === "restRequest" &&
        (target?.kind === "restCollection" || target?.kind === "restFolder");
      if (!targetKind || (targetKind !== dragKind && !restFolderDrop && !restRequestDrop)) return;

      const insertBeforeId =
        dragKind === "db"
          ? target?.kind === "connection"
            ? target.config.id
            : undefined
          : dragKind === "ssh"
            ? target?.kind === "ssh"
              ? target.conn.id
              : undefined
            : dragKind === "web"
              ? target?.kind === "webLink"
                ? target.link.id
                : undefined
              : dragKind === "docker"
                ? target?.kind === "dockerHost"
                  ? target.host.id
                  : undefined
              : dragKind === "rest"
                ? target?.kind === "restCollection"
                  ? target.collection.id
                  : undefined
              : dragKind === "restFolder" || dragKind === "restRequest"
                ? undefined
              : dragKind === "vscode"
                ? target?.kind === "vscodeFavorite"
                  ? target.favorite.id
                  : undefined
              : target?.kind === "ollama"
                ? target.endpoint.id
                : undefined;

      if (dragKind === "db") {
        const all = store.list();
        const draggedIds = new Set(dragged.map((d) => d.id));
        const remaining = all.filter((c) => !draggedIds.has(c.id));
        const moved = all.filter((c) => draggedIds.has(c.id));
        const idx = insertBeforeId ? remaining.findIndex((c) => c.id === insertBeforeId) : -1;
        const next = idx >= 0 ? [...remaining.slice(0, idx), ...moved, ...remaining.slice(idx)] : [...remaining, ...moved];
        await store.saveAll(next);
      } else if (dragKind === "ssh") {
        const all = sshStore.list();
        const draggedIds = new Set(dragged.map((d) => d.id));
        const remaining = all.filter((c) => !draggedIds.has(c.id));
        const moved = all.filter((c) => draggedIds.has(c.id));
        const idx = insertBeforeId ? remaining.findIndex((c) => c.id === insertBeforeId) : -1;
        const next = idx >= 0 ? [...remaining.slice(0, idx), ...moved, ...remaining.slice(idx)] : [...remaining, ...moved];
        await sshStore.saveAll(next);
      } else if (dragKind === "web") {
        const all = webLinkStore.list();
        const draggedIds = new Set(dragged.map((d) => d.id));
        const remaining = all.filter((c) => !draggedIds.has(c.id));
        const moved = all.filter((c) => draggedIds.has(c.id));
        const idx = insertBeforeId ? remaining.findIndex((c) => c.id === insertBeforeId) : -1;
        const next = idx >= 0 ? [...remaining.slice(0, idx), ...moved, ...remaining.slice(idx)] : [...remaining, ...moved];
        await webLinkStore.saveAll(next);
      } else if (dragKind === "docker") {
        const all = dockerStore.list();
        const draggedIds = new Set(dragged.map((d) => d.id));
        const remaining = all.filter((c) => !draggedIds.has(c.id));
        const moved = all.filter((c) => draggedIds.has(c.id));
        const idx = insertBeforeId ? remaining.findIndex((c) => c.id === insertBeforeId) : -1;
        const next = idx >= 0 ? [...remaining.slice(0, idx), ...moved, ...remaining.slice(idx)] : [...remaining, ...moved];
        await dockerStore.saveAll(next);
      } else if (dragKind === "rest") {
        const movedIds = dragged.map((d) => d.id);
        for (const id of movedIds) {
          await restProvider.moveCollectionBefore(id, insertBeforeId);
        }
      } else if (dragKind === "restFolder") {
        const targetCollectionId =
          target?.kind === "restCollection" ? target.collection.id : target?.kind === "restFolder" ? target.collectionId : undefined;
        const targetFolderId = target?.kind === "restFolder" ? target.folder.id : undefined;
        if (!targetCollectionId) return;
        for (const item of dragged) {
          if (item.kind !== "restFolder") continue;
          await restProvider.moveFolderTo(item.id, targetCollectionId, targetFolderId);
        }
      } else if (dragKind === "restRequest") {
        const targetCollectionId =
          target?.kind === "restCollection" ? target.collection.id : target?.kind === "restFolder" ? target.collectionId : undefined;
        const targetFolderId = target?.kind === "restFolder" ? target.folder.id : undefined;
        if (!targetCollectionId) return;
        for (const item of dragged) {
          if (item.kind !== "restRequest") continue;
          await restProvider.moveRequestTo(item.id, targetCollectionId, targetFolderId);
        }
      } else if (dragKind === "vscode") {
        const all = vsCodeFavoriteStore.list();
        const draggedIds = new Set(dragged.map((d) => d.id));
        const remaining = all.filter((c) => !draggedIds.has(c.id));
        const moved = all.filter((c) => draggedIds.has(c.id));
        const idx = insertBeforeId ? remaining.findIndex((c) => c.id === insertBeforeId) : -1;
        const next = idx >= 0 ? [...remaining.slice(0, idx), ...moved, ...remaining.slice(idx)] : [...remaining, ...moved];
        await vsCodeFavoriteStore.saveAll(next);
      } else {
        const all = ollamaStore.list();
        const draggedIds = new Set(dragged.map((d) => d.id));
        const remaining = all.filter((c) => !draggedIds.has(c.id));
        const moved = all.filter((c) => draggedIds.has(c.id));
        const idx = insertBeforeId ? remaining.findIndex((c) => c.id === insertBeforeId) : -1;
        const next = idx >= 0 ? [...remaining.slice(0, idx), ...moved, ...remaining.slice(idx)] : [...remaining, ...moved];
        await ollamaStore.saveAll(next);
      }

      view.refresh();
    }
  };

  const treeView = vscode.window.createTreeView("moreConnectConnections", {
    treeDataProvider: view,
    dragAndDropController
  });
  context.subscriptions.push(
    treeView,
    output,
    restProvider.onDidChangeState(() => view.refresh()),
    treeView.onDidExpandElement(async (e) => {
      if (e.element.kind !== "group") return;
      await setExplorerGroupExpanded(e.element.group, true);
    }),
    treeView.onDidCollapseElement(async (e) => {
      if (e.element.kind !== "group") return;
      await setExplorerGroupExpanded(e.element.group, false);
    }),
    treeView.onDidChangeSelection((e) => {
      const node = e.selection[0];
      if (!node) return;
      if (node.kind === "database") {
        setActiveDatabaseForConnection(node.connectionId, node.database);
        return;
    }
    if (node.kind === "table") {
      setActiveDatabaseForConnection(node.connectionId, node.database);
      return;
    }
    if (node.kind === "sqlFolder") {
      setActiveDatabaseForConnection(node.connectionId, node.database);
      return;
    }
      if (node.kind === "sqlItem") {
        setActiveDatabaseForConnection(node.connectionId, node.database);
      }
    }),
  )
  ;

  function postResultsStatus(text: string): void {
    resultsPanel.postMessage({ type: "results.status", text });
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
    const timeoutMs = getConnectionTimeoutMs();
    if (config.sshEnabled) {
      const sshPw = await ensureSshPassword(config);
      if (sshPw === undefined) return;
      try {
        const forwarded = await tunnels.ensureTunnel(config, sshPw, timeoutMs);
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
      await withTimeout(
        client.connect(password),
        timeoutMs,
        `Connection timed out after ${timeoutMs}ms (check host/port/credentials).`
      );
    } catch (e) {
      const err = e as Error;
      if (err.message?.startsWith("Missing driver:")) {
        await showMissingDriverHelp(context, driverDir.fsPath, err.message);
        return;
      }
      try {
        await disconnect(config);
      } catch {}
      if (err instanceof TimeoutError) throw new Error(err.message);
      throw e;
    }
    view.refresh();
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
        const forwarded = await tunnels.ensureTunnel(effective, sshPassword, timeoutMs);
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
      await withTimeout(
        client.connect(pw),
        timeoutMs,
        `Connection timed out after ${timeoutMs}ms (check host/port/credentials).`
      );
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

    if (config.database) setActiveDatabaseForConnection(config.id, config.database);
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
    const fileCtx = getSqlFileContext(doc.uri);
    const active = getActiveConnection();
    const selectedConn = fileCtx?.connectionId
      ? connections.find((c) => c.id === fileCtx.connectionId)
      : undefined;
    const effectiveConn = selectedConn ?? active;
    const effectiveDb =
      fileCtx?.database ?? effectiveConn?.database ?? getActiveDatabaseForConnection(effectiveConn?.id);

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
      const fallbackDb = getActiveDatabaseForConnection(config.id);
      const effectiveDb = fileCtx?.database ?? config.database ?? fallbackDb;
      const effectiveConfig = effectiveDb ? { ...config, database: effectiveDb } : config;
      await runQuery(effectiveConfig, sql);
      await setSqlFileContext(editor.document.uri, { connectionId: effectiveConfig.id, database: effectiveConfig.database });
    } catch (e) {
      vscode.window.showErrorMessage(`Query failed[0]: ${(e as Error).message}`);
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

    const fileCtx = getSqlFileContext(doc.uri);
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
      const fallbackDb = getActiveDatabaseForConnection(config.id);
      const effectiveDb = fileCtx?.database ?? config.database ?? fallbackDb;
      const effectiveConfig = effectiveDb ? { ...config, database: effectiveDb } : config;
      await runQuery(effectiveConfig, sql);
      if (!doc.isUntitled && doc.fileName.toLowerCase().endsWith(".sql")) {
        await setSqlFileContext(doc.uri, { connectionId: effectiveConfig.id, database: effectiveConfig.database });
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Query failed[2]: ${(e as Error).message}`);
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
      setActiveDatabaseForConnection(config.id, pick.label);
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
      infoPanel.show(`DB Info: ${node.database}`, body, {
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
        `<h2>Columns</h2>`,
        columnsTable,
        `<h2>Indexes</h2>`,
        indexesTable
      ].join("\n");

      infoPanel.show(`Table Info: ${tableName}`, body, {
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
        const activeNode: ExplorerNode = {
          kind: "connection",
          config,
          connected: true,
          active: true
        };
        await treeView.reveal(activeNode, { expand: true, focus: false, select: false });
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
        vscode.window.showErrorMessage(`Query failed[2]: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.runQueryFromEditor", async () => {
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
        vscode.window.showErrorMessage(`Query failed[4]: ${(e as Error).message}`);
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
        vscode.window.showErrorMessage(`Query failed[3]: ${(e as Error).message}`);
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
