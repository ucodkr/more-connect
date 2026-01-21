import * as vscode from "vscode";
import type { SshConnection } from "../types";

const FILE_NAME = "more-connect-ssh.json";
const CONFIG_NAME = "connections-storage.json";

export class SshStore {
  private items: SshConnection[] = [];
  private folder: vscode.Uri;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.folder = context.globalStorageUri;
  }

  public async init(): Promise<void> {
    this.folder = await this.loadFolder();
    this.items = (await this.readFile(this.folder)) ?? [];
  }

  public list(): SshConnection[] {
    return this.items;
  }

  public async saveAll(items: SshConnection[]): Promise<void> {
    this.items = items;
    await this.writeFile(this.folder, items);
  }

  public getFolderUri(): vscode.Uri {
    return this.folder;
  }

  public async setFolderUri(folder: vscode.Uri | undefined): Promise<void> {
    const next = folder ?? this.context.globalStorageUri;
    await this.writeFile(next, this.items);
    this.folder = next;
    await this.saveFolder(next);
  }

  private fileUri(folder: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(folder, FILE_NAME);
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

  private async readFile(folder: vscode.Uri): Promise<SshConnection[] | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri(folder));
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as SshConnection[]) : undefined;
    } catch {
      return;
    }
  }

  private async writeFile(folder: vscode.Uri, items: SshConnection[]): Promise<void> {
    await vscode.workspace.fs.createDirectory(folder);
    const text = JSON.stringify(items, null, 2);
    await vscode.workspace.fs.writeFile(this.fileUri(folder), Buffer.from(text, "utf8"));
  }
}
