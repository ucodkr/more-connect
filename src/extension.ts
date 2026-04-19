import * as vscode from "vscode";
import type { ConnectionConfig } from "./types";
import {
  listDockerContainers,
  listDockerImages,
  listDockerNetworks,
  listDockerVolumes
} from "./docker/dockerClient";
import { DockerStore } from "./docker/dockerStore";
import { ConnectionStore } from "./storage";
import { ResultsPanel } from "./ui/resultsPanel";
import { InfoPanel } from "./ui/infoPanel";
import { ConnectionWizard } from "./ui/connectionWizard";
import { ExplorerView, type ExplorerNode } from "./ui/explorerView";
import { OllamaChatPanel } from "./ui/ollamaChatPanel";
import { TunnelManager } from "./ssh/tunnelManager";
import { SshStore } from "./ssh/sshStore";
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
import { registerS3Commands } from "./extension/s3Commands";
import { registerSshCommands } from "./extension/sshCommands";
import { registerVsCodeFavoriteCommands } from "./extension/vscodeFavoriteCommands";
import { registerWebCommands } from "./extension/webCommands";
import { createExtensionState } from "./extension/state";
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
import { createGlobalStorageModuleLoader, logStoragePaths } from "./extension/runtime";
import { escapeHtml, renderTable } from "./extension/sqlUtils";
import { createDbRuntime } from "./extension/dbRuntime";
import { registerConnectionCommands } from "./extension/connectionCommands";
import { createSqlController } from "./extension/sqlCommands";
import { listBuckets, listFolder } from "./s3/s3Client";
import { S3Store } from "./s3/s3Store";

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
  const s3Store = new S3Store(context, context.secrets);
  await s3Store.init();
  const restProvider = new RestViewProvider(context);
  const output = vscode.window.createOutputChannel("More Connect");
  let ollamaController: ReturnType<typeof createOllamaController>;
  const ollamaChatPanel = new OllamaChatPanel(context, async (panelKey, msg) => {
    await ollamaController.handleOllamaChatPanelMessage(panelKey, msg);
  });

  logStoragePaths(output, context, store);

  let sqlController!: ReturnType<typeof createSqlController>;
  const resultsPanel = new ResultsPanel(context, async (msg) => {
    await sqlController.handleResultsPanelMessage(msg);
  });
  const infoPanel = new InfoPanel(context);
  const connectionWizard = new ConnectionWizard(context);
  const sqlStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sqlStatus.name = "More Connect SQL Context";
  sqlStatus.command = "moreConnect.selectConnectionForSql";
  context.subscriptions.push(sqlStatus);

  const driverDir = vscode.Uri.joinPath(context.globalStorageUri, "drivers");
  const moduleLoader = createGlobalStorageModuleLoader(driverDir.fsPath);
  const tunnels = new TunnelManager(moduleLoader);
  const extensionVersion = String(context.extension.packageJSON.version ?? "dev");

  try {
    await vscode.workspace.fs.createDirectory(driverDir);
  } catch {}

  let view!: ExplorerView;
  const state = createExtensionState({
    globalState: context.globalState,
    activeConnectionKey: ACTIVE_CONNECTION_KEY,
    savedSqlKey: SAVED_SQL_KEY,
    sqlFileContextKey: SQL_FILE_CONTEXT_KEY,
    explorerGroupStateKey: EXPLORER_GROUP_STATE_KEY,
    onActiveConnectionChanged: () => {
      view?.refresh();
      sqlController?.updateSqlStatus();
    },
    onSqlContextChanged: () => {
      sqlController?.updateSqlStatus();
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
  ollamaController = createOllamaController({
    ollamaStore,
    ollamaChatPanel,
    sessionStore: {
      listSessions: ollamaSessionStore.listSessions,
      saveSessions: ollamaSessionStore.saveSessions,
      upsertSession: ollamaSessionStore.upsertSession
    }
  });

  const dbRuntime = createDbRuntime({
    context,
    driverDirFsPath: driverDir.fsPath,
    moduleLoader,
    tunnels,
    view: {
      refresh: () => view?.refresh()
    },
    onDidUseDatabase: setActiveDatabaseForConnection
  });

  view = new ExplorerView({
    listConnections: () => store.list(),
    listSshConnections: () => sshStore.list(),
    listWebLinks: () => webLinkStore.list(),
    listDockerHosts: () => dockerStore.list(),
    listS3Hosts: () => s3Store.list(),
    listS3Buckets: async (host) => {
      const secret = await s3Store.getSecret(host.id);
      if (!secret?.secretAccessKey) return [];
      return await listBuckets(host, {
        accessKeyId: host.accessKeyId,
        secretAccessKey: secret.secretAccessKey,
        sessionToken: secret.sessionToken
      });
    },
    listS3Folder: async (host, bucket, prefix) => {
      const secret = await s3Store.getSecret(host.id);
      if (!secret?.secretAccessKey) return { prefixes: [], objects: [] };
      const listed = await listFolder(
        host,
        {
          accessKeyId: host.accessKeyId,
          secretAccessKey: secret.secretAccessKey,
          sessionToken: secret.sessionToken
        },
        bucket,
        prefix
      );
      return { prefixes: listed.prefixes, objects: listed.objects.map((o) => ({ key: o.key, size: o.size })) };
    },
    listDockerContainers: async (host) => await listDockerContainers(host),
    listDockerImages: async (host) => await listDockerImages(host),
    listDockerVolumes: async (host) => await listDockerVolumes(host),
    listDockerNetworks: async (host) => await listDockerNetworks(host),
    listRestCollections: async () => await restProvider.listCollections(),
    listRestItems: async (collectionId, parentFolderId) => await restProvider.listItems(collectionId, parentFolderId),
    listVsCodeFavorites: () => vsCodeFavoriteStore.list(),
    listOllamaEndpoints: () => ollamaStore.list(),
    listOllamaModels: async (endpoint) => await ollamaController.fetchOllamaModels(endpoint),
    isConnected: (id) => dbRuntime.isConnected(id),
    getActiveConnectionId,
    listFavoriteSql: (connectionId, database) =>
      listSavedSql()
        .filter((s) => s.favorite === true && s.connectionId === connectionId && (s.database ?? "") === (database ?? ""))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .map((s) => ({ id: s.id, name: s.name, sql: s.sql })),
    listDatabases: async (config) => await dbRuntime.listDatabases(config),
    listTables: async (config, database) => await dbRuntime.listTables(config, database),
    isGroupExpanded: (group) => getExplorerGroupState()[group],
    getVersionLabel: () => `More Connect v${extensionVersion}`
  });

  const treeView = vscode.window.createTreeView("moreConnectConnections", {
    treeDataProvider: view
  });

  function getActiveConnection(): ConnectionConfig | undefined {
    const activeId = getActiveConnectionId();
    return activeId ? store.list().find((c) => c.id === activeId) : undefined;
  }

  function pickConnectedOrAnyConnection(): ConnectionConfig | undefined {
    const connections = store.list();
    if (connections.length === 0) return;
    const active = getActiveConnection();
    if (active) return active;
    return connections[0];
  }

  sqlController = createSqlController({
    context,
    store,
    output,
    resultsPanel,
    infoPanel,
    view,
    sqlStatus,
    dbRuntime,
    getActiveConnectionId,
    getActiveDatabaseForConnection,
    setActiveDatabaseForConnection,
    getSqlFileContext,
    setSqlFileContext,
    listSavedSql,
    upsertSavedSql
  });

  registerAppCommands(context, {
    store,
    sshStore,
    webLinkStore,
    dockerStore,
    s3Store,
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
  registerS3Commands(context, {
    s3Store,
    view
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
  registerConnectionCommands(context, {
    context,
    store,
    view,
    treeView,
    connectionWizard,
    dbRuntime,
    getActiveConnectionId,
    setActiveConnectionId,
    pickConnectedOrAnyConnection
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
    treeView.onDidChangeSelection(async (e) => {
      const node = e.selection[0];
      if (!node) return;
      if (node.kind === "connection") {
        await setActiveConnectionId(node.config.id);
        return;
      }
      if (node.kind === "database" || node.kind === "table" || node.kind === "sqlFolder" || node.kind === "sqlItem") {
        setActiveDatabaseForConnection(node.connectionId, node.database);
      }
    }),
    vscode.commands.registerCommand("moreConnect.previewTable", sqlController.previewTable),
    vscode.commands.registerCommand("moreConnect.runQuery", sqlController.runPromptedQuery),
    vscode.commands.registerCommand("moreConnect.runQueryFromEditor", sqlController.runQueryFromEditor),
    vscode.commands.registerCommand("moreConnect.runSqlFile", sqlController.runSqlFileOnActiveConnection),
    vscode.commands.registerCommand("moreConnect.runSqlFromEditor", sqlController.runSqlFromEditor),
    vscode.commands.registerCommand("moreConnect.selectConnectionForSql", sqlController.selectConnectionForSqlFile),
    vscode.commands.registerCommand("moreConnect.selectDatabaseForSql", sqlController.selectDatabaseForSqlFile),
    vscode.commands.registerCommand("moreConnect.newSql", sqlController.createNewSqlFromContext),
    vscode.commands.registerCommand("moreConnect.openSavedSql", sqlController.openSavedSqlPicker),
    vscode.commands.registerCommand("moreConnect.saveSqlToGlobal", sqlController.saveActiveEditorSqlToGlobal),
    vscode.commands.registerCommand("moreConnect.addSqlFavoriteFromEditor", sqlController.addSqlFavoriteFromEditor),
    vscode.commands.registerCommand("moreConnect.showDatabaseInfo", sqlController.showDatabaseInfo),
    vscode.commands.registerCommand("moreConnect.showTableInfo", sqlController.showTableInfo),
    vscode.commands.registerCommand("moreConnect.generateTableDdl", sqlController.generateTableDdl),
    vscode.commands.registerCommand("moreConnect.exportMysqlDatabaseViaDocker", sqlController.exportMysqlDatabaseViaDocker),
    vscode.commands.registerCommand("moreConnect.importMysqlDatabaseViaDocker", sqlController.importMysqlDatabaseViaDocker),
    vscode.commands.registerCommand("moreConnect.runFavoriteSql", sqlController.runFavoriteSql),
    vscode.window.onDidChangeActiveTextEditor(() => sqlController.updateSqlStatus()),
    vscode.workspace.onDidCloseTextDocument(() => sqlController.updateSqlStatus()),
    vscode.languages.registerCodeLensProvider({ language: "sql" }, sqlController.createCodeLensProvider())
  );

  sqlController.updateSqlStatus();
}

export async function deactivate() {}
