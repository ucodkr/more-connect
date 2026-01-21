import type { ConnectionConfig } from "./types";
import * as vscode from "vscode";

const LEGACY_KEY = "moreConnect.connections";
const FILE_NAME = "more-connect-connections.json";
const CONFIG_NAME = "connections-storage.json";

export class ConnectionStore {
  private connections: ConnectionConfig[] = [];
  private folder: vscode.Uri;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.folder = context.globalStorageUri;
  }

  // Always uses a JSON file. No connections are written to globalState.
  public async init(legacyMemento?: vscode.Memento): Promise<void> {
    this.folder = await this.loadFolder();
    this.connections = await this.loadConnections(legacyMemento);
  }

  public list(): ConnectionConfig[] {
    return this.connections;
  }

  public async saveAll(connections: ConnectionConfig[]): Promise<void> {
    this.connections = connections;
    try {
      await this.writeConnectionsFile(this.folder, connections);
    } catch (e) {
      // Never fall back to globalState; persistence is file-only.
      await vscode.window.showErrorMessage(
        `Failed to save connections file at ${this.connectionsFileUri(this.folder).fsPath}: ${(e as Error).message}`
      );
      // eslint-disable-next-line no-console
      console.error("[more-connect] saveAll failed", e);
    }
  }

  public getFolderUri(): vscode.Uri | undefined {
    return this.folder;
  }

  public async setFolderUri(folder: vscode.Uri | undefined): Promise<void> {
    const next = folder ?? this.context.globalStorageUri;
    await this.writeConnectionsFile(next, this.connections);
    this.folder = next;
    await this.saveFolder(next);
  }

  private async loadFolder(): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(this.context.globalStorageUri, CONFIG_NAME);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text) as { folderUri?: string } | undefined;
      return parsed?.folderUri ? vscode.Uri.parse(parsed.folderUri) : this.context.globalStorageUri;
    } catch {
      return this.context.globalStorageUri;
    }
  }

  private async saveFolder(folder: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const uri = vscode.Uri.joinPath(this.context.globalStorageUri, CONFIG_NAME);
    const text = JSON.stringify({ folderUri: folder.toString() }, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
  }

  private connectionsFileUri(folder: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(folder, FILE_NAME);
  }

  private async loadConnections(legacyMemento?: vscode.Memento): Promise<ConnectionConfig[]> {
    const fromFile = await this.readConnectionsFile(this.folder);
    if (fromFile) return fromFile;

    const fromLegacy = legacyMemento?.get<ConnectionConfig[]>(LEGACY_KEY, []) ?? [];
    if (fromLegacy.length > 0) {
      await this.writeConnectionsFile(this.folder, fromLegacy);
      await legacyMemento?.update(LEGACY_KEY, undefined);
      return fromLegacy;
    }

    await this.writeConnectionsFile(this.folder, []);
    return [];
  }

  private async readConnectionsFile(folder: vscode.Uri): Promise<ConnectionConfig[] | undefined> {
    const uri = this.connectionsFileUri(folder);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as ConnectionConfig[]) : undefined;
    } catch (e) {
      if (e instanceof vscode.FileSystemError && /FileNotFound/i.test(String((e as any).code ?? e.message))) return;
      return;
    }
  }

  private async writeConnectionsFile(folder: vscode.Uri, connections: ConnectionConfig[]): Promise<void> {
    await vscode.workspace.fs.createDirectory(folder);
    const uri = this.connectionsFileUri(folder);
    const text = JSON.stringify(connections, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
  }
}
