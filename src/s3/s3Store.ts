import * as vscode from "vscode";
import type { S3Host } from "../types";

const FILE_NAME = "more-connect-s3.json";
const CONFIG_NAME = "connections-storage.json";
const SECRET_PREFIX = "moreConnect.s3.secret.";

type StoredSecret = {
  secretAccessKey: string;
  sessionToken?: string;
};

export class S3Store {
  private items: S3Host[] = [];
  private folder: vscode.Uri;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: vscode.SecretStorage
  ) {
    this.folder = context.globalStorageUri;
  }

  public async init(): Promise<void> {
    this.folder = await this.loadFolder();
    this.items = (await this.readFile(this.folder)) ?? [];
  }

  public list(): S3Host[] {
    return this.items;
  }

  public async saveAll(items: S3Host[]): Promise<void> {
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

  public async getSecret(hostId: string): Promise<StoredSecret | undefined> {
    const raw = await this.secrets.get(this.secretKey(hostId));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as StoredSecret;
      if (!parsed?.secretAccessKey) return;
      return parsed;
    } catch {
      return;
    }
  }

  public async setSecret(hostId: string, secret: StoredSecret): Promise<void> {
    await this.secrets.store(this.secretKey(hostId), JSON.stringify(secret));
  }

  public async deleteSecret(hostId: string): Promise<void> {
    await this.secrets.delete(this.secretKey(hostId));
  }

  private secretKey(hostId: string): string {
    return `${SECRET_PREFIX}${hostId}`;
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

  private async readFile(folder: vscode.Uri): Promise<S3Host[] | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri(folder));
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as S3Host[]) : undefined;
    } catch {
      return;
    }
  }

  private async writeFile(folder: vscode.Uri, items: S3Host[]): Promise<void> {
    await vscode.workspace.fs.createDirectory(folder);
    const text = JSON.stringify(items, null, 2);
    await vscode.workspace.fs.writeFile(this.fileUri(folder), Buffer.from(text, "utf8"));
  }
}

