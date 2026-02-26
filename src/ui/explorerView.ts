import * as vscode from "vscode";
import type { ConnectionConfig, OllamaEndpoint, SshConnection, VsCodeFavorite, WebLink } from "../types";

export type ExplorerGroupName = "db" | "ssh" | "web" | "ollama" | "vscode";

export type ExplorerNode =
  | {
      kind: "group";
      group: ExplorerGroupName;
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
      kind: "sqlFolder";
      connectionId: string;
      database: string;
    }
  | {
      kind: "sqlItem";
      connectionId: string;
      database: string;
      id: string;
      name: string;
      sql: string;
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
    }
  | {
      kind: "webLink";
      link: WebLink;
    }
  | {
      kind: "ollama";
      endpoint: OllamaEndpoint;
    }
  | {
      kind: "ollamaModel";
      endpointId: string;
      model: string;
    }
  | {
      kind: "vscodeFavorite";
      favorite: VsCodeFavorite;
    };

export type ExplorerDataSource = {
  listConnections(): ConnectionConfig[];
  listSshConnections(): SshConnection[];
  listWebLinks(): WebLink[];
  listVsCodeFavorites(): VsCodeFavorite[];
  listOllamaEndpoints(): OllamaEndpoint[];
  listOllamaModels(endpoint: OllamaEndpoint): Promise<string[]>;
  isConnected(id: string): boolean;
  getActiveConnectionId(): string | undefined;
  listDatabases(connection: ConnectionConfig): Promise<string[]>;
  listFavoriteSql(connectionId: string, database: string): Array<{ id: string; name: string; sql: string }>;
  listTables(
    connection: ConnectionConfig,
    database: string
  ): Promise<Array<{ name: string; schema?: string; type?: string }>>;
  isGroupExpanded(group: ExplorerGroupName): boolean;
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
        const label =
          element.group === "db"
            ? "DB Connections"
            : element.group === "ssh"
              ? "SSH Connections"
              : element.group === "web"
                ? "Web Links"
                : element.group === "vscode"
                  ? "Folder/ Worksapce Favorites"
                : "Ollama";
        const item = new vscode.TreeItem(
          label,
          this.source.isGroupExpanded(element.group)
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.contextValue =
          element.group === "db"
            ? "dbGroup"
            : element.group === "ssh"
              ? "sshGroup"
              : element.group === "web"
                ? "webGroup"
                : element.group === "vscode"
                  ? "vscodeGroup"
                : "ollamaGroup";
        item.iconPath = new vscode.ThemeIcon(
          element.group === "db"
            ? "database"
            : element.group === "ssh"
              ? "terminal"
              : element.group === "web"
                ? "globe"
                : element.group === "vscode"
                  ? "code"
                : "hubot"
        );
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
      case "sqlFolder": {
        const item = new vscode.TreeItem("SQL", vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "sqlFolder";
        item.iconPath = new vscode.ThemeIcon("file-code");
        return item;
      }
      case "sqlItem": {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "sqlItem";
        item.iconPath = new vscode.ThemeIcon("play");
        item.command = {
          command: "moreConnect.runFavoriteSql",
          title: "Run SQL",
          arguments: [element]
        };
        // Avoid showing raw SQL in the explorer list/tooltip.
        item.tooltip = element.name;
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
      case "webLink": {
        const item = new vscode.TreeItem(element.link.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "webLink";
        item.description = element.link.url;
        item.tooltip = element.link.url;
        item.iconPath = new vscode.ThemeIcon("link-external");
        item.command = {
          command: "moreConnect.openExternalBrowser",
          title: "Open External Browser",
          arguments: [element]
        };
        return item;
      }
      case "ollama": {
        const item = new vscode.TreeItem(element.endpoint.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "ollamaConnection";
        const provider = element.endpoint.provider === "vllm" ? "vLLM" : "Ollama";
        item.description = `${provider} • ${element.endpoint.url}`;
        item.tooltip = `${provider}: ${element.endpoint.url}`;
        item.iconPath = new vscode.ThemeIcon("hubot");
        return item;
      }
      case "ollamaModel": {
        const item = new vscode.TreeItem(element.model, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "ollamaModel";
        item.iconPath = new vscode.ThemeIcon("symbol-field");
        item.command = {
          command: "moreConnect.ollamaChat",
          title: "Chat",
          arguments: [element]
        };
        return item;
      }
      case "vscodeFavorite": {
        const item = new vscode.TreeItem(element.favorite.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "vscodeFavorite";
        item.description = element.favorite.kind === "workspace" ? ".code-workspace" : "folder";
        item.tooltip = element.favorite.targetPath;
        item.iconPath = new vscode.ThemeIcon(element.favorite.kind === "workspace" ? "file-submodule" : "folder");
        return item;
      }
    }
  }

  public async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!element) {
      return [
        { kind: "group", group: "db" },
        { kind: "group", group: "ssh" },
        { kind: "group", group: "web" },
        { kind: "group", group: "vscode" },
        { kind: "group", group: "ollama" }
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

    if (element.kind === "group" && element.group === "web") {
      return this.source.listWebLinks().map((link) => ({ kind: "webLink", link }));
    }

    if (element.kind === "group" && element.group === "vscode") {
      return this.source.listVsCodeFavorites().map((favorite) => ({ kind: "vscodeFavorite", favorite }));
    }

    if (element.kind === "group" && element.group === "ollama") {
      return this.source.listOllamaEndpoints().map((endpoint) => ({ kind: "ollama", endpoint }));
    }

    if (element.kind === "ollama") {
      const models = await this.source.listOllamaModels(element.endpoint);
      return models.map((model) => ({ kind: "ollamaModel", endpointId: element.endpoint.id, model }));
    }

    if (element.kind === "connection") {
      const databases = await this.source.listDatabases(element.config);
      return databases.map((db) => ({ kind: "database", connectionId: element.config.id, database: db }));
    }

    if (element.kind === "database") {
      const config = this.source.listConnections().find((c) => c.id === element.connectionId);
      if (!config) return [];
      const tables = await this.source.listTables(config, element.database);
      return [
        { kind: "sqlFolder", connectionId: element.connectionId, database: element.database },
        ...tables.map((t) => ({
          kind: "table" as const,
          connectionId: element.connectionId,
          database: element.database,
          table: t.name,
          schema: t.schema,
          tableType: t.type
        }))
      ];
    }

    if (element.kind === "sqlFolder") {
      const items = this.source.listFavoriteSql(element.connectionId, element.database);
      return items.map((s) => ({
        kind: "sqlItem",
        connectionId: element.connectionId,
        database: element.database,
        id: s.id,
        name: s.name,
        sql: s.sql
      }));
    }

    return [];
  }
}
