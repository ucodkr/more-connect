import * as vscode from "vscode";
import type { SshConnection } from "../types";

export type SshNode = {
  kind: "ssh";
  conn: SshConnection;
};

export type SshDataSource = {
  list(): SshConnection[];
};

export class SshTreeView implements vscode.TreeDataProvider<SshNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SshNode | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  public constructor(private readonly source: SshDataSource) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: SshNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.conn.name, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "sshConnection";
    item.description = element.conn.hostName ?? "";
    item.tooltip = element.conn.target;
    item.iconPath = new vscode.ThemeIcon("terminal");
    item.command = {
      command: "moreConnect.openSshTerminal",
      title: "Open SSH Terminal",
      arguments: [element]
    };
    return item;
  }

  public async getChildren(): Promise<SshNode[]> {
    return this.source.list().map((conn) => ({ kind: "ssh", conn }));
  }
}

