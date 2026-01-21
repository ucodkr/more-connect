import * as vscode from "vscode";
import type { ConnectionConfig, SshConnection } from "../types";

export type ExplorerNode =
  | {
      kind: "group";
      group: "db" | "ssh";
    }
  | {
      kind: "connection";
      config: ConnectionConfig;
      connected: boolean;
      active: boolean;
    }
  | {
      kind: "database";
      connectionId: string;
      database: string;
    }
  | {
      kind: "table";
      connectionId: string;
      database: string;
      table: string;
      schema?: string;
      tableType?: string;
    }
  | {
      kind: "ssh";
      conn: SshConnection;
    };

export type ExplorerDataSource = {
  listConnections(): ConnectionConfig[];
  listSshConnections(): SshConnection[];
  isConnected(id: string): boolean;
  getActiveConnectionId(): string | undefined;
  listDatabases(connection: ConnectionConfig): Promise<string[]>;
  listTables(
    connection: ConnectionConfig,
    database: string
  ): Promise<Array<{ name: string; schema?: string; type?: string }>>;
};

export class ExplorerView implements vscode.TreeDataProvider<ExplorerNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExplorerNode | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  public constructor(private readonly source: ExplorerDataSource) {}

  public refresh(node?: ExplorerNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  public getTreeItem(element: ExplorerNode): vscode.TreeItem {
    switch (element.kind) {
      case "group": {
        const label = element.group === "db" ? "DB Connections" : "SSH Connections";
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = element.group === "db" ? "dbGroup" : "sshGroup";
        item.iconPath = new vscode.ThemeIcon(element.group === "db" ? "database" : "terminal");
        return item;
      }
      case "connection": {
        const label = element.config.name + (element.active ? " (active)" : "");
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = element.connected ? "connectionConnected" : "connection";
        item.description = `${element.config.type} ${element.connected ? "●" : "○"}`;
        item.tooltip = `${element.config.type}@${element.config.host}:${element.config.port}${
          element.config.database ? `/${element.config.database}` : ""
        }`;
        item.iconPath = element.connected
          ? new vscode.ThemeIcon("plug", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon("circle-outline");
        return item;
      }
      case "database": {
        const item = new vscode.TreeItem(element.database, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "database";
        item.iconPath = new vscode.ThemeIcon("database");
        return item;
      }
      case "table": {
        const name = element.schema ? `${element.schema}.${element.table}` : element.table;
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "table";
        item.description = element.tableType ?? "";
        item.iconPath = new vscode.ThemeIcon("table");
        item.command = {
          command: "moreConnect.previewTable",
          title: "Preview Table",
          arguments: [element]
        };
        return item;
      }
      case "ssh": {
        const item = new vscode.TreeItem(element.conn.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "sshConnection";
        item.description = element.conn.hostName ?? "";
        item.tooltip = element.conn.target;
        item.iconPath = new vscode.ThemeIcon("terminal");
        return item;
      }
    }
  }

  public async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!element) {
      return [
        { kind: "group", group: "db" },
        { kind: "group", group: "ssh" }
      ];
    }

    if (element.kind === "group" && element.group === "db") {
      const activeId = this.source.getActiveConnectionId();
      return this.source.listConnections().map((config) => ({
        kind: "connection",
        config,
        connected: this.source.isConnected(config.id),
        active: activeId === config.id
      }));
    }

    if (element.kind === "group" && element.group === "ssh") {
      return this.source.listSshConnections().map((conn) => ({ kind: "ssh", conn }));
    }

    if (element.kind === "connection") {
      const databases = await this.source.listDatabases(element.config);
      return databases.map((db) => ({ kind: "database", connectionId: element.config.id, database: db }));
    }

    if (element.kind === "database") {
      const config = this.source.listConnections().find((c) => c.id === element.connectionId);
      if (!config) return [];
      const tables = await this.source.listTables(config, element.database);
      return tables.map((t) => ({
        kind: "table",
        connectionId: element.connectionId,
        database: element.database,
        table: t.name,
        schema: t.schema,
        tableType: t.type
      }));
    }

    return [];
  }
}
