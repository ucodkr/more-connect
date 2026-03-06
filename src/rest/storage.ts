import * as vscode from "vscode";
import { PersistedState } from "./models";

export type StorageMode = "workspace" | "global";
const CONFIG_NAME = "connections-storage.json";

const DEFAULT_STATE: PersistedState = {
  version: 1,
  collections: [],
  environments: [{ id: "env_default", name: "Default", vars: [] }],
  selectedEnvironmentId: "env_default",
  selectedRequestId: undefined,
  history: [],
};

export class StorageService {
  private fileUri: vscode.Uri;
  private historyUri: vscode.Uri;
  private defaultGlobalFileUri: vscode.Uri;
  private defaultGlobalHistoryUri: vscode.Uri;

  constructor(private context: vscode.ExtensionContext) {
    this.fileUri = vscode.Uri.joinPath(context.globalStorageUri, "state.json");
    this.historyUri = vscode.Uri.joinPath(context.globalStorageUri, "history.json");
    this.defaultGlobalFileUri = this.fileUri;
    this.defaultGlobalHistoryUri = this.historyUri;
  }

  async getConfiguredGlobalStorageFolder (): Promise<vscode.Uri | null> {
    const fromShared = await this.loadSharedFolder();
    if (fromShared) return fromShared;
    const raw = (vscode.workspace.getConfiguration("moreConnect").get<string>("restGlobalStorageFolder", "") || "").trim();
    return raw ? vscode.Uri.file(raw) : null;
  }

  async setConfiguredGlobalStorageFolder (folder: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const uri = vscode.Uri.joinPath(this.context.globalStorageUri, CONFIG_NAME);
    const text = JSON.stringify({ folderUri: folder.toString() }, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
  }

  async load (mode: StorageMode, folder?: vscode.WorkspaceFolder): Promise<PersistedState> {
    try {
      this.fileUri = await this.getFileUriForMode(mode, folder);
      this.historyUri = await this.getHistoryUriForMode(mode, folder);
      // If a global storage folder is configured but files don't exist yet,
      // fall back to VS Code global storage and copy into the folder (best-effort).
      if (mode === "global" && (await this.getConfiguredGlobalStorageFolder())) {
        const ensureSeeded = async (src: vscode.Uri, dest: vscode.Uri) => {
          try {
            await vscode.workspace.fs.stat(dest);
          } catch {
            try {
              const bytes = await vscode.workspace.fs.readFile(src);
              await vscode.workspace.fs.writeFile(dest, bytes);
            } catch {
              // ignore
            }
          }
        };
        await ensureSeeded(this.defaultGlobalFileUri, this.fileUri);
        await ensureSeeded(this.defaultGlobalHistoryUri, this.historyUri);
      }
      await this.ensureDir();
      const data = await vscode.workspace.fs.readFile(this.fileUri);
      const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as PersistedState;
      if (parsed?.version !== 1) return DEFAULT_STATE;
      // basic repair
      parsed.environments ??= DEFAULT_STATE.environments;
      parsed.history = await this.loadHistory();
      if (!parsed.environments.length) parsed.environments = DEFAULT_STATE.environments;
      const envIds = new Set(parsed.environments.map((e) => e.id));
      if (!parsed.selectedEnvironmentId || !envIds.has(parsed.selectedEnvironmentId)) {
        parsed.selectedEnvironmentId = parsed.environments[0]?.id;
      }
      return parsed;
    } catch {
      return DEFAULT_STATE;
    }
  }

  async save (state: PersistedState, mode: StorageMode, folder?: vscode.WorkspaceFolder): Promise<void> {
    this.fileUri = await this.getFileUriForMode(mode, folder);
    this.historyUri = await this.getHistoryUriForMode(mode, folder);
    await this.ensureDir();
    const { history, ...rest } = state;
    const bytes = Buffer.from(JSON.stringify({ ...rest, history: [] }, null, 2), "utf8");
    await vscode.workspace.fs.writeFile(this.fileUri, bytes);
    await this.saveHistory(history || []);
  }

  getFileUri (): vscode.Uri {
    return this.fileUri;
  }

  async getFileUriForMode (mode: StorageMode, folder?: vscode.WorkspaceFolder): Promise<vscode.Uri> {
    if (mode === "workspace" && folder) {
      return vscode.Uri.joinPath(folder.uri, "more.rest.json");
    }
    const globalFolder = await this.getConfiguredGlobalStorageFolder();
    if (globalFolder) return vscode.Uri.joinPath(globalFolder, "more.rest.json");
    return vscode.Uri.joinPath(this.context.globalStorageUri, "state.json");
  }

  async getHistoryUriForMode (mode: StorageMode, folder?: vscode.WorkspaceFolder): Promise<vscode.Uri> {
    if (mode === "workspace" && folder) {
      return vscode.Uri.joinPath(folder.uri, "more.rest.history.json");
    }
    const globalFolder = await this.getConfiguredGlobalStorageFolder();
    if (globalFolder) return vscode.Uri.joinPath(globalFolder, "more.rest.history.json");
    return vscode.Uri.joinPath(this.context.globalStorageUri, "history.json");
  }

  getStorageFolderUriForMode (mode: StorageMode, folder?: vscode.WorkspaceFolder): vscode.Uri {
    if (mode === "workspace" && folder) return folder.uri;
    return this.context.globalStorageUri;
  }

  private async ensureDir () {
    try {
      const dir = vscode.Uri.joinPath(this.fileUri, "..");
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      // ignore
    }
  }

  async getStorageFolderUriForModeAsync (mode: StorageMode, folder?: vscode.WorkspaceFolder): Promise<vscode.Uri> {
    if (mode === "workspace" && folder) return folder.uri;
    const configured = await this.getConfiguredGlobalStorageFolder();
    if (configured) return configured;
    return this.context.globalStorageUri;
  }

  private async loadSharedFolder(): Promise<vscode.Uri | null> {
    const uri = vscode.Uri.joinPath(this.context.globalStorageUri, CONFIG_NAME);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text) as { folderUri?: string } | undefined;
      return parsed?.folderUri ? vscode.Uri.parse(parsed.folderUri) : null;
    } catch {
      return null;
    }
  }

  private async loadHistory () {
    try {
      const data = await vscode.workspace.fs.readFile(this.historyUri);
      const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveHistory (history: PersistedState["history"]) {
    const bytes = Buffer.from(JSON.stringify(history, null, 2), "utf8");
    await vscode.workspace.fs.writeFile(this.historyUri, bytes);
  }
}
