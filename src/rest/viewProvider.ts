import * as vscode from "vscode";
import { BUILD_HASH } from "./flags";
import { StorageMode, StorageService } from "./storage";
import type { Collection, Environment, FolderItem, HistoryEntry, OAuth2Config, PersistedState, RequestItem, SendResult, WebviewState } from "./models";
import { interpolate, now, uid } from "./utils";
import { sendRequest } from "./httpClient";
import { exportPostmanCollection, exportPostmanEnvironment, importPostmanCollection, importPostmanEnvironment, isPostmanCollection, isPostmanEnvironment } from "./postman";
import {
  oauthAuthorizeCodePKCE,
  oauthClientCredentials,
  oauthRefreshToken,
  type OAuthToken,
  isExpired,
} from "./oauth2";

type Msg =
  | { type: "ready" }
  | { type: "openStorageFolder" }
  | { type: "setGlobalStorageFolder" }
  | { type: "createCollection"; name?: string }
  | { type: "updateCollectionName"; collectionId: string; name?: string }
  | { type: "createFolder"; collectionId: string; parentFolderId?: string; name?: string }
  | { type: "updateFolderName"; collectionId: string; folderId: string; name?: string }
  | { type: "createRequest"; collectionId: string; parentFolderId?: string; name?: string }
  | { type: "updateRequestName"; requestId: string; name?: string }
  | { type: "selectRequest"; requestId: string }
  | { type: "saveRequest"; request: RequestItem }
  | { type: "sendRequest"; requestId: string }
  | { type: "cancelRequest"; requestId: string }
  | { type: "duplicateRequest"; requestId: string }
  | { type: "moveRequest"; requestId: string; collectionId: string; targetFolderId?: string }
  | { type: "deleteItem"; itemId: string }
  | { type: "moveCollection"; collectionId: string; targetCollectionId?: string }
  | { type: "sortCollection"; collectionId: string; mode: "name" | "method" }
  | { type: "createEnv"; name?: string }
  | { type: "saveEnv"; env: Environment; select?: boolean }
  | { type: "selectEnv"; envId: string }
  | { type: "deleteEnv"; envId: string }
  | { type: "openEnvEditor" }
  | { type: "deleteHistoryEntry"; entryId: string }
  | { type: "clearHistory" }
  | { type: "setStorageMode"; mode: StorageMode }
  | { type: "saveLocal" }
  | { type: "saveGlobal" }
  | { type: "importData" }
  | { type: "exportData" }
  | { type: "oauthAuthorize"; requestId: string; config: OAuth2Config };

type MsgOut =
  | { type: "state"; state: WebviewState }
  | { type: "sendResult"; requestId: string; result: SendResult }
  | { type: "toast"; kind: "info" | "error"; message: string };

function findRequest (collections: Collection[], id: string): RequestItem | null {
  const walk = (items: Array<FolderItem | RequestItem>): RequestItem | null => {
    for (const it of items) {
      if ((it as any).type === "request" && (it as RequestItem).id === id) return it as RequestItem;
      if ((it as any).type === "folder") {
        const r = walk((it as FolderItem).items || []);
        if (r) return r;
      }
    }
    return null;
  };
  for (const c of collections) {
    const r = walk(c.items || []);
    if (r) return r;
  }
  return null;
}

function findItemsContainer (col: Collection, folderId?: string): Array<FolderItem | RequestItem> | null {
  if (!folderId) return col.items;
  const walk = (items: Array<FolderItem | RequestItem>): Array<FolderItem | RequestItem> | null => {
    for (const it of items) {
      if ((it as any).type === "folder") {
        const f = it as FolderItem;
        if (f.id === folderId) return f.items;
        const nested = walk(f.items || []);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(col.items || []);
}

function upsertRequest (collections: Collection[], req: RequestItem): Collection[] {
  const walk = (items: Array<FolderItem | RequestItem>): boolean => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if ((it as any).type === "request" && (it as RequestItem).id === req.id) {
        items[i] = req;
        return true;
      }
      if ((it as any).type === "folder") {
        if (walk((it as FolderItem).items || [])) return true;
      }
    }
    return false;
  };
  for (const c of collections) {
    if (walk(c.items || [])) return collections;
  }
  return collections;
}

function removeItem (collections: Collection[], itemId: string): { removed: boolean; removedRequestIds: string[] } {
  const removedReqIds: string[] = [];

  const collectReqIds = (node: any) => {
    if (node?.type === "request") removedReqIds.push(node.id);
    if (node?.type === "folder") {
      for (const ch of node.items || []) collectReqIds(ch);
    }
  };

  const colIndex = collections.findIndex((c) => c.id === itemId);
  if (colIndex >= 0) {
    const col = collections[colIndex];
    for (const it of col.items || []) collectReqIds(it);
    collections.splice(colIndex, 1);
    return { removed: true, removedRequestIds: removedReqIds };
  }

  const walk = (items: Array<FolderItem | RequestItem>): boolean => {
    for (let i = 0; i < items.length; i++) {
      const it: any = items[i];
      if (it.id === itemId) {
        collectReqIds(it);
        items.splice(i, 1);
        return true;
      }
      if (it.type === "folder") {
        if (walk(it.items || [])) return true;
      }
    }
    return false;
  };

  for (const c of collections) {
    if (walk(c.items || [])) return { removed: true, removedRequestIds: removedReqIds };
  }
  return { removed: false, removedRequestIds: removedReqIds };
}

function extractRequest (collections: Collection[], requestId: string): RequestItem | null {
  const walk = (items: Array<FolderItem | RequestItem>): RequestItem | null => {
    for (let i = 0; i < items.length; i++) {
      const it: any = items[i];
      if (it.type === "request" && it.id === requestId) {
        items.splice(i, 1);
        return it as RequestItem;
      }
      if (it.type === "folder") {
        const found = walk(it.items || []);
        if (found) return found;
      }
    }
    return null;
  };
  for (const c of collections) {
    const found = walk(c.items || []);
    if (found) return found;
  }
  return null;
}

function findFolder (collections: Collection[], folderId: string): FolderItem | null {
  const walk = (items: Array<FolderItem | RequestItem>): FolderItem | null => {
    for (const item of items) {
      if (item.type !== "folder") continue;
      if (item.id === folderId) return item;
      const nested = walk(item.items || []);
      if (nested) return nested;
    }
    return null;
  };

  for (const collection of collections) {
    const found = walk(collection.items || []);
    if (found) return found;
  }
  return null;
}

function extractFolder (collections: Collection[], folderId: string): FolderItem | null {
  const walk = (items: Array<FolderItem | RequestItem>): FolderItem | null => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type !== "folder") continue;
      if (item.id === folderId) {
        items.splice(i, 1);
        return item;
      }
      const nested = walk(item.items || []);
      if (nested) return nested;
    }
    return null;
  };

  for (const collection of collections) {
    const found = walk(collection.items || []);
    if (found) return found;
  }
  return null;
}

function folderContainsFolderId (folder: FolderItem, folderId: string): boolean {
  for (const item of folder.items || []) {
    if (item.type !== "folder") continue;
    if (item.id === folderId) return true;
    if (folderContainsFolderId(item, folderId)) return true;
  }
  return false;
}

function cloneRequest (req: RequestItem): RequestItem {
  const copy = JSON.parse(JSON.stringify(req)) as RequestItem;
  copy.id = uid("req");
  copy.name = `${req.name} Copy`;
  copy.createdAt = now();
  copy.updatedAt = now();
  // if oauth2 config is embedded, create new config id to avoid overwriting tokens
  if (copy.oauth2) {
    copy.oauth2.id = uid("oauth");
    copy.auth = { type: "oauth2", configId: copy.oauth2.id };
  }
  return copy;
}

function cloneCollection (collection: Collection): Collection {
  const cloneItem = (item: FolderItem | RequestItem): FolderItem | RequestItem => {
    if (item.type === "request") {
      return cloneRequest(item);
    }
    return {
      id: uid("fld"),
      type: "folder",
      name: `${item.name} Copy`,
      items: (item.items || []).map((child) => cloneItem(child)),
    };
  };

  return {
    id: uid("col"),
    name: `${collection.name} Copy`,
    items: (collection.items || []).map((item) => cloneItem(item)),
  };
}

function cloneFolder (folder: FolderItem): FolderItem {
  const cloneItem = (item: FolderItem | RequestItem): FolderItem | RequestItem => {
    if (item.type === "request") {
      return cloneRequest(item);
    }
    return {
      id: uid("fld"),
      type: "folder",
      name: `${item.name} Copy`,
      items: (item.items || []).map((child) => cloneItem(child)),
    };
  };

  return {
    id: uid("fld"),
    type: "folder",
    name: `${folder.name} Copy`,
    items: (folder.items || []).map((item) => cloneItem(item)),
  };
}

function sortItems (items: Array<FolderItem | RequestItem>, mode: "name" | "method") {
  // sort folders first then requests; recurse into folders
  for (const it of items) {
    if ((it as any).type === "folder") sortItems((it as FolderItem).items || [], mode);
  }

  const keyFolder = (f: FolderItem) => f.name.toLowerCase();
  const keyReqName = (r: RequestItem) => r.name.toLowerCase();
  const keyReqMethod = (r: RequestItem) => `${r.method}_${r.name}`.toLowerCase();

  items.sort((a: any, b: any) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    if (a.type === "folder") return keyFolder(a).localeCompare(keyFolder(b));
    if (mode === "method") return keyReqMethod(a).localeCompare(keyReqMethod(b));
    return keyReqName(a).localeCompare(keyReqName(b));
  });
}

function updateCollectionName (collections: Collection[], collectionId: string, name: string): boolean {
  const col = collections.find((c) => c.id === collectionId);
  if (!col) return false;
  col.name = name;
  return true;
}

function updateFolderName (collections: Collection[], collectionId: string, folderId: string, name: string): boolean {
  const col = collections.find((c) => c.id === collectionId);
  if (!col) return false;
  const walk = (items: Array<FolderItem | RequestItem>): boolean => {
    for (const it of items) {
      if ((it as any).type === "folder") {
        const f = it as FolderItem;
        if (f.id === folderId) {
          f.name = name;
          return true;
        }
        if (walk(f.items || [])) return true;
      }
    }
    return false;
  };
  return walk(col.items || []);
}

function updateRequestName (collections: Collection[], requestId: string, name: string): boolean {
  const req = findRequest(collections, requestId);
  if (!req) return false;
  req.name = name;
  req.updatedAt = now();
  return true;
}

export class RestViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "moreConnect.restView";
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeState = this.onDidChangeStateEmitter.event;
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private envPanel?: vscode.WebviewPanel;
  private fileWatcher?: vscode.FileSystemWatcher;
  private historyWatcher?: vscode.FileSystemWatcher;
  private fileReloadTimer?: NodeJS.Timeout;
  private activeEditorListener?: vscode.Disposable;
  private activeWorkspaceFolder?: vscode.WorkspaceFolder;
  private storageMode: StorageMode = "global";
  private inflight = new Map<string, AbortController>();

  private state!: PersistedState;
  private storage: StorageService;

  constructor(private context: vscode.ExtensionContext) {
    this.storage = new StorageService(context);
  }

  async listCollections (): Promise<Collection[]> {
    await this.ensureStateLoaded();
    return this.state.collections;
  }

  async listItems (collectionId: string, parentFolderId?: string): Promise<Array<FolderItem | RequestItem>> {
    await this.ensureStateLoaded();
    const collection = this.state.collections.find((item) => item.id === collectionId);
    if (!collection) return [];
    return findItemsContainer(collection, parentFolderId) ?? [];
  }

  async openRequest (requestId: string): Promise<void> {
    await this.ensureStateLoaded();
    const request = findRequest(this.state.collections, requestId);
    if (!request) {
      this.notify("error", "REST request not found.");
      return;
    }
    this.state.selectedRequestId = requestId;
    this.ensureRequestPanel();
    await this.saveState();
    this.postState();
  }

  async openEnvironments (): Promise<void> {
    await this.ensureStateLoaded();
    this.ensureEnvPanel();
  }

  async resolveWebviewView (webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    this.storageMode = await this.loadStorageMode();
    this.activeWorkspaceFolder = this.getActiveWorkspaceFolder();
    this.state = await this.storage.load(this.storageMode, this.activeWorkspaceFolder);
    this.ensureFileWatcher();
    this.ensureActiveEditorListener();

    webviewView.webview.html = this.renderHtml(webviewView.webview, "nav", this.getWebviewState());

    webviewView.webview.onDidReceiveMessage(async (msg: Msg) => {
      try {
        await this.onMessage(msg);
      } catch (e: any) {
        this.post({ type: "toast", kind: "error", message: e?.message ?? String(e) });
      }
    });

    this.postState();
  }

  private async ensureStateLoaded () {
    if (this.state) return;
    this.storageMode = await this.loadStorageMode();
    this.activeWorkspaceFolder = this.getActiveWorkspaceFolder();
    this.state = await this.storage.load(this.storageMode, this.activeWorkspaceFolder);
    this.ensureFileWatcher();
    this.ensureActiveEditorListener();
  }

  private ensureFileWatcher () {
    if (this.fileWatcher) return;
    if (this.storageMode !== "workspace") return;
    const folder = this.activeWorkspaceFolder;
    if (!folder) return;
    const pattern = new vscode.RelativePattern(folder, "more.rest.json");
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = () => this.queueStateReload();
    this.fileWatcher.onDidChange(onChange);
    this.fileWatcher.onDidCreate(onChange);
    const historyPattern = new vscode.RelativePattern(folder, "more.rest.history.json");
    this.historyWatcher = vscode.workspace.createFileSystemWatcher(historyPattern);
    this.historyWatcher.onDidChange(onChange);
    this.historyWatcher.onDidCreate(onChange);
  }

  private queueStateReload () {
    if (this.fileReloadTimer) clearTimeout(this.fileReloadTimer);
    this.fileReloadTimer = setTimeout(async () => {
      try {
        this.activeWorkspaceFolder = this.getActiveWorkspaceFolder();
        this.state = await this.storage.load(this.storageMode, this.activeWorkspaceFolder);
        this.postState();
      } catch {
        // ignore reload errors
      }
    }, 300);
  }

  private ensureActiveEditorListener () {
    if (this.activeEditorListener) return;
    this.activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
      if (this.storageMode !== "workspace") return;
      const next = this.getActiveWorkspaceFolder();
      if (!next || next.uri.toString() === this.activeWorkspaceFolder?.uri.toString()) return;
      this.activeWorkspaceFolder = next;
      if (this.fileWatcher) {
        this.fileWatcher.dispose();
        this.fileWatcher = undefined;
      }
      this.ensureFileWatcher();
      this.queueStateReload();
    });
    this.context.subscriptions.push(this.activeEditorListener);
  }

  private getActiveWorkspaceFolder (): vscode.WorkspaceFolder | undefined {
    const active = vscode.window.activeTextEditor?.document?.uri;
    if (active) {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) return folder;
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  private async loadStorageMode (): Promise<StorageMode> {
    const saved = this.context.globalState.get<StorageMode>("moreConnect.rest.storageMode");
    if (saved === "workspace" || saved === "global") return saved;
    if (await this.storage.getConfiguredGlobalStorageFolder()) return "global";
    return vscode.workspace.workspaceFolders?.length ? "workspace" : "global";
  }

  private async setStorageMode (mode: StorageMode) {
    if (mode === "workspace" && !vscode.workspace.workspaceFolders?.length) {
      this.post({ type: "toast", kind: "error", message: "No workspace open. Using global storage instead." });
      this.storageMode = "global";
    } else {
      this.storageMode = mode;
    }
    await this.context.globalState.update("moreConnect.rest.storageMode", this.storageMode);
    this.activeWorkspaceFolder = this.getActiveWorkspaceFolder();
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
    if (this.historyWatcher) {
      this.historyWatcher.dispose();
      this.historyWatcher = undefined;
    }
    this.ensureFileWatcher();
    this.state = await this.storage.load(this.storageMode, this.activeWorkspaceFolder);
    this.postState();
  }

  private mediaUri (webview: vscode.Webview, path: string) {
    return webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", path));
  }

  private getWebviewState (): WebviewState {
    const selected = this.getSelectedRequest();
    return {
      collections: this.state.collections,
      environments: this.state.environments,
      selectedEnvironmentId: this.state.selectedEnvironmentId,
      selectedRequest: selected,
      history: this.state.history,
      storageMode: this.storageMode,
      storagePath: "",
      storageIsCustom: true,
      storageCanOpenFolder: true,
    };
  }

  private renderHtml (webview: vscode.Webview, mode: "nav" | "editor" | "env", state?: WebviewState): string {
    const csp = [
      "default-src 'none';",
      `img-src ${webview.cspSource} https: data:;`,
      `style-src ${webview.cspSource} 'unsafe-inline';`,
      `script-src ${webview.cspSource};`,
    ].join(" ");
    const cacheBuster = this.context.extensionMode === vscode.ExtensionMode.Development
      ? String(Date.now())
      : (BUILD_HASH || "dev");
    const v = encodeURIComponent(cacheBuster);
    const js = `${this.mediaUri(webview, "rest-app.js")}?v=${v}`;
    const css = `${this.mediaUri(webview, "rest-styles.css")}?v=${v}`;
    const stateAttr = state ? ` data-state="${encodeURIComponent(JSON.stringify(state))}"` : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${css}">
  <title>More Connect REST</title>
</head>
<body>
  <div id="root" data-mode="${mode}"${stateAttr}></div>
  <script src="${js}"></script>
</body>
</html>`;
  }

  private notify (kind: "info" | "error", message: string) {
    this.post({ type: "toast", kind, message });
    const hasWebviewUi = Boolean(this.view || this.panel || this.envPanel);
    if (hasWebviewUi) return;
    if (kind === "error") vscode.window.showErrorMessage(message);
    else vscode.window.showInformationMessage(message);
  }

  private post (msg: MsgOut) {
    this.view?.webview.postMessage(msg);
    this.panel?.webview.postMessage(msg);
    this.envPanel?.webview.postMessage(msg);
  }

  private envById (id?: string): Environment | undefined {
    return this.state.environments.find((e) => e.id === id);
  }

  private getSelectedRequest (): RequestItem | null {
    const id = this.state.selectedRequestId;
    if (!id) return null;
    return findRequest(this.state.collections, id);
  }

  private postState () {
    void this.postStateAsync();
  }

  private async postStateAsync () {
    const selected = this.getSelectedRequest();
    const globalConfigured = Boolean(await this.storage.getConfiguredGlobalStorageFolder());
    const canOpen = this.storageMode === "workspace"
      ? Boolean(this.activeWorkspaceFolder)
      : globalConfigured;
    if (this.panel) {
      this.panel.title = selected ? `REST: ${selected.name}` : "More Connect REST";
    }
    if (this.envPanel) {
      this.envPanel.title = "More Connect REST Environments";
    }
    this.post({
      type: "state",
      state: {
        ...this.getWebviewState(),
        storagePath: (await this.storage.getStorageFolderUriForModeAsync(this.storageMode, this.activeWorkspaceFolder)).fsPath,
        storageIsCustom: this.storageMode === "global" ? globalConfigured : true,
        storageCanOpenFolder: canOpen,
      },
    });
    this.onDidChangeStateEmitter.fire();
  }

  private async saveState () {
    await this.storage.save(this.state, this.storageMode, this.activeWorkspaceFolder);
    this.onDidChangeStateEmitter.fire();
  }

  private async saveToWorkspaceFile () {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      this.post({ type: "toast", kind: "error", message: "No workspace open." });
      return;
    }
    const target = await this.storage.getFileUriForMode("workspace", folder);
    try {
      await vscode.workspace.fs.stat(target);
      const choice = await vscode.window.showWarningMessage(
        "more.rest.json already exists in this project. Overwrite it with global data?",
        { modal: true },
        "Overwrite",
        "Cancel"
      );
      if (choice !== "Overwrite") return;
    } catch {
      // file does not exist yet
    }
    const globalState = await this.storage.load("global");
    this.state = globalState;
    this.storageMode = "workspace";
    await this.context.globalState.update("moreConnect.rest.storageMode", this.storageMode);
    await this.storage.save(globalState, "workspace", folder);
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
    if (this.historyWatcher) {
      this.historyWatcher.dispose();
      this.historyWatcher = undefined;
    }
    this.ensureFileWatcher();
    this.postState();
    this.post({ type: "toast", kind: "info", message: "Synced global to project (more.rest.json)" });
  }

  private async saveToGlobalFile () {
    const folder = this.getActiveWorkspaceFolder();
    if (!folder) {
      this.post({ type: "toast", kind: "error", message: "No workspace open." });
      return;
    }
    if (this.storageMode !== "workspace") {
      this.post({ type: "toast", kind: "error", message: "Switch to Project mode to sync to global." });
      return;
    }
    await this.saveState();
    const target = await this.storage.getFileUriForMode("global");
    try {
      await vscode.workspace.fs.stat(target);
      const choice = await vscode.window.showWarningMessage(
        "Global storage already exists. Overwrite it with project data?",
        { modal: true },
        "Overwrite",
        "Cancel"
      );
      if (choice !== "Overwrite") return;
    } catch {
      // global file does not exist yet
    }
    const workspaceState = await this.storage.load("workspace", folder);
    await this.storage.save(workspaceState, "global");
    this.post({ type: "toast", kind: "info", message: "Synced project to global" });
  }

  async setGlobalStorageFolder (presetFolder?: vscode.Uri) {
    const current = (await this.storage.getConfiguredGlobalStorageFolder()) ?? this.context.globalStorageUri;
    const prevFileUri = await this.storage.getFileUriForMode("global");
    const prevHistoryUri = await this.storage.getHistoryUriForMode("global");
    const destFolder = presetFolder ?? (await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: current,
      openLabel: "Set global storage folder",
    }))?.[0];
    if (!destFolder) return;

    const ensureGitignore = async () => {
      const ignoreName = ".gitignore";
      const ignoreUri = vscode.Uri.joinPath(destFolder, ignoreName);
      const patterns = [
        "more.rest.history.json",
        "history.json",
      ];
      const normalize = (s: string) => s.replace(/\r\n/g, "\n");

      try {
        const existing = await vscode.workspace.fs.readFile(ignoreUri);
        const text = normalize(Buffer.from(existing).toString("utf8"));
        const lines = new Set(text.split("\n").map((l) => l.trim()).filter(Boolean));
        const missing = patterns.filter((p) => !lines.has(p));
        if (!missing.length) return;
        const next = (text.endsWith("\n") ? text : `${text}\n`) + missing.join("\n") + "\n";
        await vscode.workspace.fs.writeFile(ignoreUri, Buffer.from(next, "utf8"));
        return;
      } catch {
        // ignore: will create if folder is empty
      }

      try {
        const items = await vscode.workspace.fs.readDirectory(destFolder);
        const isEmpty = items.length === 0;
        if (!isEmpty) return;
      } catch {
        return;
      }

      const content = patterns.join("\n") + "\n";
      try {
        await vscode.workspace.fs.writeFile(ignoreUri, Buffer.from(content, "utf8"));
      } catch {
        // ignore
      }
    };

    await ensureGitignore();
    await this.storage.setConfiguredGlobalStorageFolder(destFolder);
    this.storageMode = "global";
    await this.context.globalState.update("moreConnect.rest.storageMode", this.storageMode);

    // Copy current global data into the selected folder (best-effort).
    const copyIfExists = async (src: vscode.Uri, destName: string) => {
      try {
        const bytes = await vscode.workspace.fs.readFile(src);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(destFolder, destName), bytes);
      } catch {
        // ignore missing/permission errors
      }
    };
    await copyIfExists(prevFileUri, "more.rest.json");
    await copyIfExists(prevHistoryUri, "more.rest.history.json");

    this.state = await this.storage.load(this.storageMode, this.activeWorkspaceFolder);
    this.postState();
    this.notify("info", `Global storage folder set: ${destFolder.fsPath}`);
  }

  async openStorageFolder () {
    const storageFolder = await this.storage.getStorageFolderUriForModeAsync(this.storageMode, this.activeWorkspaceFolder);
    if (this.storageMode === "global" && !(await this.storage.getConfiguredGlobalStorageFolder())) {
      this.notify("error", "Global storage folder is not set. Click ⚙ and select a folder first.");
      return;
    }
    if (this.storageMode === "workspace" && !this.activeWorkspaceFolder) {
      this.notify("error", "No workspace folder is active.");
      return;
    }
    await vscode.commands.executeCommand("vscode.openFolder", storageFolder, true);
  }

  async reveal () {
    await this.ensureStateLoaded();
    this.ensureRequestPanel();
    this.postState();
  }

  async newCollection () {
    await this.ensureStateLoaded();
    const name = await vscode.window.showInputBox({ prompt: "Collection name", value: "New Collection" });
    if (!name) return;
    await this.onMessage({ type: "createCollection", name });
    this.ensureRequestPanel();
  }

  async newRequest (collectionId?: string, parentFolderId?: string) {
    await this.ensureStateLoaded();
    if (!this.state.collections.length) {
      await this.onMessage({ type: "createCollection", name: "Default" });
    }
    const col = (collectionId && this.state.collections.find((item) => item.id === collectionId)) || this.state.collections[0];
    if (!col) return;
    const name = await vscode.window.showInputBox({ prompt: "Request name", value: "New Request" });
    if (!name) return;
    await this.onMessage({ type: "createRequest", collectionId: col.id, parentFolderId, name });
    this.ensureRequestPanel();
  }

  async newFolder (collectionId: string, parentFolderId?: string) {
    await this.ensureStateLoaded();
    const name = await vscode.window.showInputBox({ prompt: "Folder name", value: "New Folder" });
    if (!name) return;
    await this.onMessage({ type: "createFolder", collectionId, parentFolderId, name });
    this.ensureRequestPanel();
  }

  async renameCollection (collectionId: string, currentName: string): Promise<void> {
    await this.ensureStateLoaded();
    const name = await vscode.window.showInputBox({ prompt: "Collection name", value: currentName });
    if (!name) return;
    await this.onMessage({ type: "updateCollectionName", collectionId, name });
  }

  async renameFolder (collectionId: string, folderId: string, currentName: string): Promise<void> {
    await this.ensureStateLoaded();
    const name = await vscode.window.showInputBox({ prompt: "Folder name", value: currentName });
    if (!name) return;
    await this.onMessage({ type: "updateFolderName", collectionId, folderId, name });
  }

  async renameRequest (requestId: string, currentName: string): Promise<void> {
    await this.ensureStateLoaded();
    const name = await vscode.window.showInputBox({ prompt: "Request name", value: currentName });
    if (!name) return;
    await this.onMessage({ type: "updateRequestName", requestId, name });
  }

  async moveCollectionBefore (collectionId: string, targetCollectionId?: string): Promise<void> {
    await this.ensureStateLoaded();
    await this.onMessage({ type: "moveCollection", collectionId, targetCollectionId });
  }

  async moveRequestTo (requestId: string, collectionId: string, targetFolderId?: string): Promise<void> {
    await this.ensureStateLoaded();
    await this.onMessage({ type: "moveRequest", requestId, collectionId, targetFolderId });
  }

  async moveFolderTo (folderId: string, collectionId: string, targetFolderId?: string): Promise<void> {
    await this.ensureStateLoaded();
    const targetCollection = this.state.collections.find((item) => item.id === collectionId);
    if (!targetCollection) {
      this.notify("error", "Target collection not found.");
      return;
    }
    if (targetFolderId === folderId) return;

    const sourceFolder = findFolder(this.state.collections, folderId);
    if (!sourceFolder) {
      this.notify("error", "Folder not found.");
      return;
    }
    if (targetFolderId && folderContainsFolderId(sourceFolder, targetFolderId)) {
      this.notify("error", "Cannot move a folder into its child folder.");
      return;
    }

    const folder = extractFolder(this.state.collections, folderId);
    if (!folder) {
      this.notify("error", "Folder not found.");
      return;
    }

    const targetItems = findItemsContainer(targetCollection, targetFolderId);
    if (!targetItems) {
      this.notify("error", "Target folder not found.");
      return;
    }

    targetItems.push(folder);
    await this.saveState();
    this.postState();
  }

  async duplicateCollection (collectionId: string): Promise<void> {
    await this.ensureStateLoaded();
    const index = this.state.collections.findIndex((item) => item.id === collectionId);
    if (index < 0) {
      this.notify("error", "Collection not found.");
      return;
    }
    const duplicated = cloneCollection(this.state.collections[index]);
    this.state.collections.splice(index + 1, 0, duplicated);
    await this.saveState();
    this.postState();
  }

  async duplicateRequest (requestId: string): Promise<void> {
    await this.ensureStateLoaded();
    await this.onMessage({ type: "duplicateRequest", requestId });
  }

  async duplicateFolder (collectionId: string, folderId: string): Promise<void> {
    await this.ensureStateLoaded();
    const collection = this.state.collections.find((item) => item.id === collectionId);
    if (!collection) {
      this.notify("error", "Collection not found.");
      return;
    }

    const insertCopy = (items: Array<FolderItem | RequestItem>): boolean => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type === "folder" && item.id === folderId) {
          items.splice(i + 1, 0, cloneFolder(item));
          return true;
        }
        if (item.type === "folder" && insertCopy(item.items || [])) return true;
      }
      return false;
    };

    if (!insertCopy(collection.items || [])) {
      this.notify("error", "Folder not found.");
      return;
    }

    await this.saveState();
    this.postState();
  }

  async deleteItem (itemId: string, label: string): Promise<void> {
    await this.ensureStateLoaded();
    const picked = await vscode.window.showWarningMessage(
      `Delete "${label}"?`,
      { modal: true },
      "Delete"
    );
    if (picked !== "Delete") return;
    await this.onMessage({ type: "deleteItem", itemId });
  }

  async exportData () {
    await this.ensureStateLoaded();
    const choice = await vscode.window.showQuickPick(
      ["Postman Collection (v2.1)", "Postman Environment", "More Connect REST State (JSON)"],
      { placeHolder: "Export format" }
    );
    if (!choice) return;

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    let data: any = null;
    let defaultName = "more-connect-rest.json";

    if (choice.startsWith("Postman Collection")) {
      data = exportPostmanCollection(this.state.collections);
      defaultName = "more-connect-rest.postman_collection.json";
    } else if (choice.startsWith("Postman Environment")) {
      if (!this.state.environments.length) {
        this.post({ type: "toast", kind: "error", message: "No environments to export." });
        return;
      }
      const envPick = await vscode.window.showQuickPick(
        this.state.environments.map((e) => e.name),
        { placeHolder: "Select environment to export" }
      );
      if (!envPick) return;
      const env = this.state.environments.find((e) => e.name === envPick);
      if (!env) return;
      data = exportPostmanEnvironment(env);
      defaultName = `more-connect-rest.${env.name}.postman_environment.json`;
    } else {
      data = this.state;
      defaultName = "more-rest.json";
    }

    const target = await vscode.window.showSaveDialog({
      defaultUri: workspace ? vscode.Uri.joinPath(workspace, defaultName) : undefined,
      filters: { JSON: ["json"] },
    });
    if (!target) return;
    const bytes = Buffer.from(JSON.stringify(data, null, 2), "utf8");
    await vscode.workspace.fs.writeFile(target, bytes);
    this.post({ type: "toast", kind: "info", message: `Exported to ${target.fsPath}` });
  }

  async importData () {
    await this.ensureStateLoaded();
    const source = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { JSON: ["json"] },
    });
    if (!source?.[0]) return;
    const bytes = await vscode.workspace.fs.readFile(source[0]);
    let doc: any;
    try {
      doc = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      this.post({ type: "toast", kind: "error", message: "Invalid JSON file." });
      return;
    }

    if (isPostmanCollection(doc)) {
      const col = importPostmanCollection(doc);
      this.state.collections.push(col);
      await this.saveState();
      this.postState();
      this.post({ type: "toast", kind: "info", message: `Imported collection: ${col.name}` });
      return;
    }

    if (isPostmanEnvironment(doc)) {
      const env = importPostmanEnvironment(doc);
      this.state.environments.push(env);
      this.state.selectedEnvironmentId = env.id;
      await this.saveState();
      this.postState();
      this.post({ type: "toast", kind: "info", message: `Imported environment: ${env.name}` });
      return;
    }

    if (doc?.version === 1 && Array.isArray(doc.collections)) {
      const mode = await vscode.window.showQuickPick(
        ["Replace current data"],
        { placeHolder: "Import More Connect REST state" }
      );
      if (!mode) return;
      this.state = doc as PersistedState;
      if (!this.state.environments?.length) {
        this.state.environments = [{ id: "env_default", name: "Default", vars: [] }];
      }
      const envIds = new Set(this.state.environments.map((e) => e.id));
      if (!this.state.selectedEnvironmentId || !envIds.has(this.state.selectedEnvironmentId)) {
        this.state.selectedEnvironmentId = this.state.environments[0]?.id;
      }
      await this.saveState();
      this.postState();
      this.post({ type: "toast", kind: "info", message: "Imported More Connect REST state." });
      return;
    }

    this.post({ type: "toast", kind: "error", message: "Unsupported import format." });
  }

  private ensureRequestPanel () {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "moreConnect.rest.request",
      "More Connect REST",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      }
    );

    this.panel.webview.html = this.renderHtml(this.panel.webview, "editor", this.getWebviewState());

    this.panel.webview.onDidReceiveMessage(async (msg: Msg) => {
      try {
        await this.onMessage(msg);
      } catch (e: any) {
        this.post({ type: "toast", kind: "error", message: e?.message ?? String(e) });
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private ensureEnvPanel () {
    if (this.envPanel) {
      this.envPanel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.envPanel = vscode.window.createWebviewPanel(
      "moreConnect.rest.env",
      "More Connect REST Environments",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      }
    );

    this.envPanel.webview.html = this.renderHtml(this.envPanel.webview, "env", this.getWebviewState());

    this.envPanel.webview.onDidReceiveMessage(async (msg: Msg) => {
      try {
        await this.onMessage(msg);
      } catch (e: any) {
        this.post({ type: "toast", kind: "error", message: e?.message ?? String(e) });
      }
    });

    this.envPanel.onDidDispose(() => {
      this.envPanel = undefined;
    });

    this.postState();
  }

  private async ensureOAuthBearer (req: RequestItem): Promise<string | undefined> {
    if (req.auth.type !== "oauth2") return undefined;

    const config = req.oauth2;
    if (!config) {
      this.post({ type: "toast", kind: "error", message: "OAuth2 config missing on request." });
      return undefined;
    }

    const secretKey = `oauth2_secret_${config.id}`;
    const tokenKey = `oauth2_token_${config.id}`;

    const tokStr = await this.context.secrets.get(tokenKey);
    if (!tokStr) {
      this.post({ type: "toast", kind: "error", message: "No OAuth token. Click Authorize first." });
      return undefined;
    }

    let tok = JSON.parse(tokStr) as OAuthToken;
    if (!isExpired(tok)) return tok.access_token;

    // Try automatic renewal
    const clientSecret = (await this.context.secrets.get(secretKey)) || undefined;

    try {
      if (config.flow === "authorization_code_pkce") {
        if (!tok.refresh_token) {
          this.post({ type: "toast", kind: "error", message: "OAuth token expired and has no refresh_token. Please Authorize again." });
          return undefined;
        }
        const refreshed = await oauthRefreshToken({
          tokenUrl: config.tokenUrl,
          clientId: config.clientId,
          refreshToken: tok.refresh_token,
          scope: config.scope || undefined,
          audience: config.audience,
          clientSecret,
        });
        // preserve refresh_token if omitted
        if (!refreshed.refresh_token) refreshed.refresh_token = tok.refresh_token;
        tok = refreshed;
        await this.context.secrets.store(tokenKey, JSON.stringify(tok));
        this.post({ type: "toast", kind: "info", message: `OAuth refreshed: ${config.name}` });
        return tok.access_token;
      }

      if (config.flow === "client_credentials") {
        if (!clientSecret) {
          this.post({ type: "toast", kind: "error", message: "Client secret not found. Please Authorize again." });
          return undefined;
        }
        tok = await oauthClientCredentials({
          tokenUrl: config.tokenUrl,
          clientId: config.clientId,
          clientSecret,
          scope: config.scope,
          audience: config.audience,
        });
        await this.context.secrets.store(tokenKey, JSON.stringify(tok));
        this.post({ type: "toast", kind: "info", message: `OAuth renewed (client_credentials): ${config.name}` });
        return tok.access_token;
      }
    } catch (e: any) {
      this.post({ type: "toast", kind: "error", message: `OAuth renewal failed: ${e?.message ?? String(e)}. Please Authorize again.` });
      return undefined;
    }

    return undefined;
  }

  private async onMessage (msg: Msg) {
    await this.ensureStateLoaded();
    switch (msg.type) {
      case "ready":
        this.postState();
        return;

      case "openStorageFolder":
        await this.openStorageFolder();
        return;

      case "setGlobalStorageFolder":
        await this.setGlobalStorageFolder();
        return;

      case "createCollection": {
        const name = msg.name?.trim() || "New Collection";
        const col: Collection = { id: uid("col"), name, items: [] };
        this.state.collections.push(col);
        await this.saveState();
        this.postState();
        return;
      }

      case "updateCollectionName": {
        const name = msg.name?.trim() || "";
        if (!name) throw new Error("Collection name required");
        const updated = updateCollectionName(this.state.collections, msg.collectionId, name);
        if (!updated) throw new Error("Collection not found");
        await this.saveState();
        this.postState();
        return;
      }

      case "createFolder": {
        const col = this.state.collections.find((c) => c.id === msg.collectionId);
        if (!col) throw new Error("Collection not found");
        const name = msg.name?.trim() || "New Folder";
        const folder: FolderItem = { id: uid("fld"), type: "folder", name, items: [] };
        const container = findItemsContainer(col, msg.parentFolderId);
        if (!container) throw new Error("Folder not found");
        container.push(folder);
        await this.saveState();
        this.postState();
        return;
      }

      case "updateFolderName": {
        const name = msg.name?.trim() || "";
        if (!name) throw new Error("Folder name required");
        const updated = updateFolderName(this.state.collections, msg.collectionId, msg.folderId, name);
        if (!updated) throw new Error("Folder not found");
        await this.saveState();
        this.postState();
        return;
      }

      case "createRequest": {
        const col = this.state.collections.find((c) => c.id === msg.collectionId);
        if (!col) throw new Error("Collection not found");
        const name = msg.name?.trim() || "New Request";
        const req: RequestItem = {
          id: uid("req"),
          type: "request",
          name,
          method: "GET",
          url: "https://ucod.kr/myip",
          params: [],
          headers: [{ key: "accept", value: "application/json", enabled: true }],
          body: { type: "json", json: "{}" },
          auth: { type: "none" },
          createdAt: now(),
          updatedAt: now(),
        };
        const container = findItemsContainer(col, msg.parentFolderId);
        if (!container) throw new Error("Folder not found");
        container.push(req);
        this.state.selectedRequestId = req.id;
        await this.saveState();
        this.ensureRequestPanel();
        this.postState();
        return;
      }

      case "updateRequestName": {
        const name = msg.name?.trim() || "";
        if (!name) throw new Error("Request name required");
        const updated = updateRequestName(this.state.collections, msg.requestId, name);
        if (!updated) throw new Error("Request not found");
        await this.saveState();
        this.postState();
        this.post({ type: "toast", kind: "info", message: "Name updated" });
        return;
      }

      case "selectRequest":
        this.state.selectedRequestId = msg.requestId;
        await this.saveState();
        this.ensureRequestPanel();
        this.postState();
        return;

      case "saveRequest": {
        const req = { ...msg.request, updatedAt: now() };
        this.state.collections = upsertRequest(this.state.collections, req);
        this.state.selectedRequestId = req.id;
        await this.saveState();
        this.postState();
        return;
      }

      case "duplicateRequest": {
        const orig = findRequest(this.state.collections, msg.requestId);
        if (!orig) throw new Error("Request not found");
        const copy = cloneRequest(orig);

        // insert next to original in same container
        const inserted = (() => {
          const walk = (items: Array<FolderItem | RequestItem>): boolean => {
            for (let i = 0; i < items.length; i++) {
              const it: any = items[i];
              if (it.type === "request" && it.id === orig.id) {
                items.splice(i + 1, 0, copy);
                return true;
              }
              if (it.type === "folder") {
                if (walk(it.items || [])) return true;
              }
            }
            return false;
          };
          for (const c of this.state.collections) {
            if (walk(c.items || [])) return true;
          }
          return false;
        })();

        if (!inserted) throw new Error("Failed to duplicate request");
        this.state.selectedRequestId = copy.id;
        await this.saveState();
        this.postState();
        return;
      }

      case "moveRequest": {
        const req = extractRequest(this.state.collections, msg.requestId);
        if (!req) throw new Error("Request not found");
        const targetCol = this.state.collections.find((c) => c.id === msg.collectionId);
        if (!targetCol) throw new Error("Target collection not found");
        const container = findItemsContainer(targetCol, msg.targetFolderId);
        if (!container) throw new Error("Target folder not found");
        container.push(req);
        req.updatedAt = now();
        this.state.selectedRequestId = req.id;
        await this.saveState();
        this.postState();
        return;
      }

      case "deleteItem": {
        const { removed, removedRequestIds } = removeItem(this.state.collections, msg.itemId);
        if (!removed) throw new Error("Item not found");

        if (this.state.selectedRequestId && removedRequestIds.includes(this.state.selectedRequestId)) {
          this.state.selectedRequestId = undefined;
        }

        await this.saveState();
        this.postState();
        return;
      }

      case "moveCollection": {
        const { collectionId, targetCollectionId } = msg;
        const fromIdx = this.state.collections.findIndex((c) => c.id === collectionId);
        if (fromIdx < 0) throw new Error("Collection not found");
        if (targetCollectionId && targetCollectionId === collectionId) return;
        const [col] = this.state.collections.splice(fromIdx, 1);
        let toIdx = targetCollectionId
          ? this.state.collections.findIndex((c) => c.id === targetCollectionId)
          : -1;
        if (toIdx < 0) {
          this.state.collections.push(col);
        } else {
          this.state.collections.splice(toIdx, 0, col);
        }
        await this.saveState();
        this.postState();
        return;
      }

      case "sortCollection": {
        const col = this.state.collections.find((c) => c.id === msg.collectionId);
        if (!col) throw new Error("Collection not found");
        sortItems(col.items || [], msg.mode);
        await this.saveState();
        this.postState();
        return;
      }

      case "createEnv": {
        const name = msg.name?.trim() || "New Env";
        const env: Environment = { id: uid("env"), name, vars: [] };
        this.state.environments.push(env);
        this.state.selectedEnvironmentId = env.id;
        await this.saveState();
        this.postState();
        return;
      }

      case "saveEnv": {
        const idx = this.state.environments.findIndex((e) => e.id === msg.env.id);
        if (idx >= 0) this.state.environments[idx] = msg.env;
        else this.state.environments.push(msg.env);
        if (msg.select) this.state.selectedEnvironmentId = msg.env.id;
        await this.saveState();
        this.postState();
        return;
      }

      case "selectEnv":
        this.state.selectedEnvironmentId = msg.envId;
        await this.saveState();
        this.postState();
        return;

      case "deleteEnv": {
        const envId = msg.envId;
        this.state.environments = this.state.environments.filter((e) => e.id !== envId);
        if (this.state.selectedEnvironmentId === envId) {
          this.state.selectedEnvironmentId = this.state.environments[0]?.id;
        }
        await this.saveState();
        this.postState();
        return;
      }

      case "openEnvEditor":
        this.ensureEnvPanel();
        this.postState();
        return;

      case "deleteHistoryEntry":
        this.state.history = this.state.history.filter((h) => h.id !== msg.entryId);
        await this.saveState();
        this.postState();
        return;

      case "clearHistory":
        this.state.history = [];
        await this.saveState();
        this.postState();
        return;

      case "setStorageMode":
        await this.setStorageMode(msg.mode);
        return;

      case "saveLocal":
        await this.saveToWorkspaceFile();
        return;

      case "saveGlobal":
        await this.saveToGlobalFile();
        return;

      case "importData":
        await this.importData();
        return;

      case "exportData":
        await this.exportData();
        return;

      case "oauthAuthorize": {
        const req = findRequest(this.state.collections, msg.requestId);
        if (!req) throw new Error("Request not found");

        const config = msg.config;
        const secretKey = `oauth2_secret_${config.id}`;
        const tokenKey = `oauth2_token_${config.id}`;

        // Save config into request (so send can refresh)
        req.oauth2 = config;
        req.auth = { type: "oauth2", configId: config.id };
        this.state.collections = upsertRequest(this.state.collections, req);
        await this.saveState();
        this.postState();

        let clientSecret = await this.context.secrets.get(secretKey);
        if (config.flow === "client_credentials") {
          if (!clientSecret) {
            clientSecret = await vscode.window.showInputBox({
              prompt: `Client Secret for ${config.name}`,
              password: true,
              ignoreFocusOut: true,
            });
            if (!clientSecret) throw new Error("Client secret required for client_credentials");
            await this.context.secrets.store(secretKey, clientSecret);
          }
        } else {
          // PKCE: secret optional; ask only if user wants
          if (!clientSecret) {
            const ask = await vscode.window.showQuickPick(["No (PKCE only)", "Yes (send client_secret)"], {
              placeHolder: "Do you need to send client_secret during token exchange?",
            });
            if (ask === "Yes (send client_secret)") {
              clientSecret = await vscode.window.showInputBox({
                prompt: `Client Secret for ${config.name} (optional)`,
                password: true,
                ignoreFocusOut: true,
              });
              if (clientSecret) await this.context.secrets.store(secretKey, clientSecret);
            }
          }
        }

        let token: OAuthToken;
        if (config.flow === "authorization_code_pkce") {
          token = await oauthAuthorizeCodePKCE({
            name: config.name,
            authorizationUrl: config.authorizationUrl,
            tokenUrl: config.tokenUrl,
            clientId: config.clientId,
            scope: config.scope,
            audience: config.audience,
            clientSecret: clientSecret || undefined,
          });
        } else {
          token = await oauthClientCredentials({
            tokenUrl: config.tokenUrl,
            clientId: config.clientId,
            clientSecret: clientSecret || "",
            scope: config.scope,
            audience: config.audience,
          });
        }

        await this.context.secrets.store(tokenKey, JSON.stringify(token));
        this.post({ type: "toast", kind: "info", message: `OAuth2 authorized: ${config.name}` });
        return;
      }

      case "sendRequest": {
        const req = findRequest(this.state.collections, msg.requestId);
        if (!req) throw new Error("Request not found");

        const env = this.envById(this.state.selectedEnvironmentId);
        const oauthBearer = await this.ensureOAuthBearer(req);

        const controller = new AbortController();
        this.inflight.set(req.id, controller);
        const result = await sendRequest(req, env, oauthBearer, controller.signal);
        this.inflight.delete(req.id);
        this.post({ type: "sendResult", requestId: req.id, result });

        // history
        const resolvedUrl = interpolate(req.url, env);
        const entry: HistoryEntry = {
          id: uid("his"),
          ts: Date.now(),
          requestId: req.id,
          request: { name: req.name, method: req.method, url: resolvedUrl },
          response: result.status ? { status: result.status, ms: result.ms || 0, size: result.size || 0 } : undefined,
          error: result.ok ? undefined : result.error,
        };
        this.state.history.unshift(entry);
        this.state.history = this.state.history.slice(0, 50);
        await this.saveState();
        this.postState();
        return;
      }

      case "cancelRequest": {
        const controller = this.inflight.get(msg.requestId);
        if (controller) {
          controller.abort();
          this.inflight.delete(msg.requestId);
          this.post({ type: "toast", kind: "info", message: "Request cancelled." });
        }
        return;
      }

      default:
        return;
    }
  }
}
