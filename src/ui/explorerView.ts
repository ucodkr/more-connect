import * as vscode from "vscode";
import type { DockerCategory, DockerContainerInfo, DockerImageInfo, DockerNetworkInfo, DockerVolumeInfo } from "../docker/dockerClient";
import type { ConnectionConfig, DockerHost, OllamaEndpoint, S3Host, SshConnection, VsCodeFavorite, WebLink } from "../types";
import type { Collection as RestCollection, FolderItem as RestFolderItem, RequestItem as RestRequestItem } from "../rest/models";

export type ExplorerGroupName = "db" | "ssh" | "web" | "rest" | "s3" | "docker" | "ollama" | "vscode";

export type ExplorerNode =
  | {
    kind: "group";
    group: ExplorerGroupName;
  }
  | {
    kind: "empty";
    label: string;
  }
  | {
    kind: "versionInfo";
    label: string;
    tooltip?: string;
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
    kind: "dockerHost";
    host: DockerHost;
  }
  | {
    kind: "dockerCategory";
    hostId: string;
    category: DockerCategory;
  }
  | {
    kind: "dockerContainer";
    hostId: string;
    container: DockerContainerInfo;
  }
  | {
    kind: "dockerImage";
    hostId: string;
    image: DockerImageInfo;
  }
  | {
    kind: "dockerVolume";
    hostId: string;
    volume: DockerVolumeInfo;
  }
  | {
    kind: "dockerNetwork";
    hostId: string;
    network: DockerNetworkInfo;
  }
  | {
    kind: "restCollection";
    collection: RestCollection;
  }
  | {
    kind: "restFolder";
    collectionId: string;
    folder: RestFolderItem;
  }
  | {
    kind: "restRequest";
    collectionId: string;
    request: RestRequestItem;
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
  }
  | {
    kind: "s3Host";
    host: S3Host;
  }
  | {
    kind: "s3Bucket";
    hostId: string;
    bucket: string;
  }
  | {
    kind: "s3Prefix";
    hostId: string;
    bucket: string;
    prefix: string;
    name: string;
  }
  | {
    kind: "s3Object";
    hostId: string;
    bucket: string;
    key: string;
    name: string;
    size?: number;
  };

export type ExplorerDataSource = {
  listConnections(): ConnectionConfig[];
  listSshConnections(): SshConnection[];
  listWebLinks(): WebLink[];
  listDockerHosts(): DockerHost[];
  listDockerContainers(host: DockerHost): Promise<DockerContainerInfo[]>;
  listDockerImages(host: DockerHost): Promise<DockerImageInfo[]>;
  listDockerVolumes(host: DockerHost): Promise<DockerVolumeInfo[]>;
  listDockerNetworks(host: DockerHost): Promise<DockerNetworkInfo[]>;
  listRestCollections(): Promise<RestCollection[]>;
  listRestItems(collectionId: string, parentFolderId?: string): Promise<Array<RestFolderItem | RestRequestItem>>;
  listVsCodeFavorites(): VsCodeFavorite[];
  listOllamaEndpoints(): OllamaEndpoint[];
  listOllamaModels(endpoint: OllamaEndpoint): Promise<string[]>;
  listS3Hosts(): S3Host[];
  listS3Buckets(host: S3Host): Promise<string[]>;
  listS3Folder(
    host: S3Host,
    bucket: string,
    prefix: string
  ): Promise<{ prefixes: string[]; objects: Array<{ key: string; size?: number }> }>;
  isConnected(id: string): boolean;
  getActiveConnectionId(): string | undefined;
  listDatabases(connection: ConnectionConfig): Promise<string[]>;
  listFavoriteSql(connectionId: string, database: string): Array<{ id: string; name: string; sql: string }>;
  listTables(
    connection: ConnectionConfig,
    database: string
  ): Promise<Array<{ name: string; schema?: string; type?: string }>>;
  isGroupExpanded(group: ExplorerGroupName): boolean;
  getVersionLabel(): string;
};

export class ExplorerView implements vscode.TreeDataProvider<ExplorerNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExplorerNode | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  public constructor(private readonly source: ExplorerDataSource) { }

  public refresh(node?: ExplorerNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  private withEmptyState(children: ExplorerNode[], label: string): ExplorerNode[] {
    return children.length > 0 ? children : [{ kind: "empty", label }];
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
                : element.group === "rest"
                  ? "REST APIs"
                  : element.group === "s3"
                    ? "S3 Browser"
                    : element.group === "docker"
                      ? "Docker"
                      : element.group === "vscode"
                        ? "Folder/Workspace Favorites"
                        : "LLM (Ollama/vLLM)";
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
                : element.group === "rest"
                  ? "restGroup"
                  : element.group === "s3"
                    ? "s3Group"
                    : element.group === "docker"
                      ? "dockerGroup"
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
                : element.group === "rest"
                  ? "radio-tower"
                  : element.group === "s3"
                    ? "cloud"
                    : element.group === "docker"
                      ? "package"
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
        item.tooltip = `${element.config.type}@${element.config.host}:${element.config.port}${element.config.database ? `/${element.config.database}` : ""
          }`;
        item.iconPath = element.connected
          ? new vscode.ThemeIcon("plug", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon("circle-outline");
        return item;
      }
      case "empty": {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "emptyState";
        item.iconPath = new vscode.ThemeIcon("circle-slash");
        return item;
      }
      case "versionInfo": {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "versionInfo";
        item.tooltip = element.tooltip ?? element.label;
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
      case "database": {
        const item = new vscode.TreeItem(element.database, vscode.TreeItemCollapsibleState.Collapsed);
        const config = this.source.listConnections().find((c) => c.id === element.connectionId);
        item.contextValue =
          config?.type === "mysql" ? "databaseMysql" : config?.type === "mariadb" ? "databaseMariaDb" : "database";
        item.iconPath = new vscode.ThemeIcon("database");
        return item;
      }
      // case "sqlFolder": {
      //   const item = new vscode.TreeItem("SQL", vscode.TreeItemCollapsibleState.Collapsed);
      //   item.contextValue = "sqlFolder";
      //   item.iconPath = new vscode.ThemeIcon("file-code");
      //   return item;
      // }
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
      case "dockerHost": {
        const item = new vscode.TreeItem(element.host.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "dockerHost";
        item.description = element.host.host;
        item.tooltip = element.host.host;
        item.iconPath = new vscode.ThemeIcon("package");
        return item;
      }
      case "dockerCategory": {
        const label =
          element.category === "containers"
            ? "Containers"
            : element.category === "images"
              ? "Images"
              : element.category === "volumes"
                ? "Volumes"
                : "Networks";
        const iconId =
          element.category === "containers"
            ? "vm"
            : element.category === "images"
              ? "archive"
              : element.category === "volumes"
                ? "database"
                : "type-hierarchy-sub";
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "dockerCategory";
        item.iconPath = new vscode.ThemeIcon(iconId);
        return item;
      }
      case "dockerContainer": {
        const item = new vscode.TreeItem(element.container.name || element.container.id, vscode.TreeItemCollapsibleState.None);
        item.contextValue = element.container.state.toLowerCase() === "running" ? "dockerContainerRunning" : "dockerContainerStopped";
        item.description = element.container.state || element.container.image;
        item.tooltip = `${element.container.image}\n${element.container.status}`;
        item.iconPath = new vscode.ThemeIcon("vm");
        // Keep selection passive; expose log viewing through the inline button.
        item.buttons = [
          {
            iconPath: new vscode.ThemeIcon("output"),
            tooltip: "Show Logs Panel",
            command: {
              command: "moreConnect.showDockerContainerLogs",
              title: "Show Logs",
              arguments: [{
                kind: "dockerContainer",
                hostId: element.hostId,
                container: element.container
              }]
            }
          }
        ];
        return item;
      }
      case "dockerImage": {
        const item = new vscode.TreeItem(
          `${element.image.repository}:${element.image.tag}`,
          vscode.TreeItemCollapsibleState.None
        );
        item.contextValue = "dockerImage";
        item.description = element.image.size;
        item.tooltip = element.image.id;
        item.iconPath = new vscode.ThemeIcon("archive");
        return item;
      }
      case "dockerVolume": {
        const item = new vscode.TreeItem(element.volume.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "dockerVolume";
        item.description = `${element.volume.driver}${element.volume.scope ? ` • ${element.volume.scope}` : ""}`;
        item.iconPath = new vscode.ThemeIcon("database");
        return item;
      }
      case "dockerNetwork": {
        const item = new vscode.TreeItem(element.network.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "dockerNetwork";
        item.description = `${element.network.driver}${element.network.scope ? ` • ${element.network.scope}` : ""}`;
        item.tooltip = element.network.id;
        item.iconPath = new vscode.ThemeIcon("type-hierarchy-sub");
        return item;
      }
      case "restCollection": {
        const item = new vscode.TreeItem(element.collection.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "restCollection";
        item.iconPath = new vscode.ThemeIcon("file-directory");
        return item;
      }
      case "restFolder": {
        const item = new vscode.TreeItem(element.folder.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "restFolder";
        item.iconPath = new vscode.ThemeIcon("folder");
        return item;
      }
      case "restRequest": {
        const item = new vscode.TreeItem(element.request.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "restRequest";
        item.description = element.request.method;
        item.command = {
          command: "moreConnect.openRestRequest",
          title: "Open REST Request",
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
        item.description =
          element.favorite.kind === "workspace"
            ? ".code-workspace"
            : element.favorite.kind === "remoteSsh"
              ? "Remote SSH"
              : "folder";
        item.tooltip = element.favorite.targetPath;
        item.iconPath = new vscode.ThemeIcon(
          element.favorite.kind === "workspace"
            ? "file-submodule"
            : element.favorite.kind === "remoteSsh"
              ? "remote-explorer"
              : "folder"
        );
        return item;
      }
      case "s3Host": {
        const item = new vscode.TreeItem(element.host.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "s3Host";
        item.description = element.host.provider === "aws" ? "AWS" : element.host.provider === "minio" ? "MinIO" : "S3";
        item.tooltip = element.host.endpointUrl ?? element.host.region;
        item.iconPath = new vscode.ThemeIcon("cloud");
        return item;
      }
      case "s3Bucket": {
        const item = new vscode.TreeItem(element.bucket, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "s3Bucket";
        item.iconPath = new vscode.ThemeIcon("archive");
        return item;
      }
      case "s3Prefix": {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "s3Prefix";
        item.iconPath = new vscode.ThemeIcon("folder");
        return item;
      }
      case "s3Object": {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "s3Object";
        item.description = typeof element.size === "number" ? `${element.size} B` : "";
        item.iconPath = new vscode.ThemeIcon("file");
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
        { kind: "group", group: "rest" },
        { kind: "group", group: "s3" },
        { kind: "group", group: "docker" },
        { kind: "group", group: "vscode" },
        { kind: "group", group: "ollama" },
        { kind: "versionInfo", label: this.source.getVersionLabel() }
      ];
    }

    if (element.kind === "group" && element.group === "db") {
      const activeId = this.source.getActiveConnectionId();
      return this.withEmptyState(this.source.listConnections().map((config) => ({
        kind: "connection",
        config,
        connected: this.source.isConnected(config.id),
        active: activeId === config.id
      })), "No DB connections");
    }

    if (element.kind === "group" && element.group === "ssh") {
      return this.withEmptyState(this.source.listSshConnections().map((conn) => ({ kind: "ssh", conn })), "No SSH connections");
    }

    if (element.kind === "group" && element.group === "web") {
      return this.withEmptyState(this.source.listWebLinks().map((link) => ({ kind: "webLink", link })), "No web links");
    }

    if (element.kind === "group" && element.group === "rest") {
      const collections = await this.source.listRestCollections();
      return this.withEmptyState(
        collections.map((collection) => ({ kind: "restCollection", collection })),
        "No REST collections"
      );
    }

    if (element.kind === "group" && element.group === "s3") {
      return this.withEmptyState(this.source.listS3Hosts().map((host) => ({ kind: "s3Host", host })), "No S3 hosts");
    }

    if (element.kind === "group" && element.group === "docker") {
      return this.withEmptyState(
        this.source.listDockerHosts().map((host) => ({ kind: "dockerHost", host })),
        "No Docker hosts"
      );
    }

    if (element.kind === "group" && element.group === "vscode") {
      return this.withEmptyState(
        this.source.listVsCodeFavorites().map((favorite) => ({ kind: "vscodeFavorite", favorite })),
        "No favorites"
      );
    }

    if (element.kind === "group" && element.group === "ollama") {
      return this.withEmptyState(
        this.source.listOllamaEndpoints().map((endpoint) => ({ kind: "ollama", endpoint })),
        "No Ollama endpoints"
      );
    }

    if (element.kind === "s3Host") {
      const buckets = await this.source.listS3Buckets(element.host);
      return this.withEmptyState(
        buckets.map((bucket) => ({ kind: "s3Bucket", hostId: element.host.id, bucket })),
        "No buckets"
      );
    }

    if (element.kind === "s3Bucket") {
      const host = this.source.listS3Hosts().find((h) => h.id === element.hostId);
      if (!host) return [];
      const { prefixes, objects } = await this.source.listS3Folder(host, element.bucket, "");
      return this.withEmptyState(
        [
          ...prefixes.map((p) => ({
            kind: "s3Prefix" as const,
            hostId: element.hostId,
            bucket: element.bucket,
            prefix: p,
            name: p.split("/").filter(Boolean).slice(-1)[0] ?? p
          })),
          ...objects.map((o) => ({
            kind: "s3Object" as const,
            hostId: element.hostId,
            bucket: element.bucket,
            key: o.key,
            name: o.key.split("/").filter(Boolean).slice(-1)[0] ?? o.key,
            size: o.size
          }))
        ],
        "Empty"
      );
    }

    if (element.kind === "s3Prefix") {
      const host = this.source.listS3Hosts().find((h) => h.id === element.hostId);
      if (!host) return [];
      const { prefixes, objects } = await this.source.listS3Folder(host, element.bucket, element.prefix);
      return this.withEmptyState(
        [
          ...prefixes.map((p) => ({
            kind: "s3Prefix" as const,
            hostId: element.hostId,
            bucket: element.bucket,
            prefix: p,
            name: p.split("/").filter(Boolean).slice(-1)[0] ?? p
          })),
          ...objects.map((o) => ({
            kind: "s3Object" as const,
            hostId: element.hostId,
            bucket: element.bucket,
            key: o.key,
            name: o.key.split("/").filter(Boolean).slice(-1)[0] ?? o.key,
            size: o.size
          }))
        ],
        "Empty"
      );
    }

    if (element.kind === "dockerHost") {
      return [
        { kind: "dockerCategory", hostId: element.host.id, category: "containers" },
        { kind: "dockerCategory", hostId: element.host.id, category: "images" },
        { kind: "dockerCategory", hostId: element.host.id, category: "volumes" },
        { kind: "dockerCategory", hostId: element.host.id, category: "networks" }
      ];
    }

    if (element.kind === "dockerCategory") {
      const host = this.source.listDockerHosts().find((item) => item.id === element.hostId);
      if (!host) return [];
      if (element.category === "containers") {
        return this.withEmptyState(
          (await this.source.listDockerContainers(host)).map((container) => ({
            kind: "dockerContainer" as const,
            hostId: host.id,
            container
          })),
          "No containers"
        );
      }
      if (element.category === "images") {
        return this.withEmptyState(
          (await this.source.listDockerImages(host)).map((image) => ({
            kind: "dockerImage" as const,
            hostId: host.id,
            image
          })),
          "No images"
        );
      }
      if (element.category === "volumes") {
        return this.withEmptyState(
          (await this.source.listDockerVolumes(host)).map((volume) => ({
            kind: "dockerVolume" as const,
            hostId: host.id,
            volume
          })),
          "No volumes"
        );
      }
      return this.withEmptyState(
        (await this.source.listDockerNetworks(host)).map((network) => ({
          kind: "dockerNetwork" as const,
          hostId: host.id,
          network
        })),
        "No networks"
      );
    }

    if (element.kind === "restCollection") {
      const items = await this.source.listRestItems(element.collection.id);
      return this.withEmptyState(items.map((item) =>
        item.type === "folder"
          ? { kind: "restFolder" as const, collectionId: element.collection.id, folder: item }
          : { kind: "restRequest" as const, collectionId: element.collection.id, request: item }
      ), "No requests or folders");
    }

    if (element.kind === "restFolder") {
      const items = await this.source.listRestItems(element.collectionId, element.folder.id);
      return this.withEmptyState(items.map((item) =>
        item.type === "folder"
          ? { kind: "restFolder" as const, collectionId: element.collectionId, folder: item }
          : { kind: "restRequest" as const, collectionId: element.collectionId, request: item }
      ), "No requests or folders");
    }

    if (element.kind === "ollama") {
      const models = await this.source.listOllamaModels(element.endpoint);
      return this.withEmptyState(
        models.map((model) => ({ kind: "ollamaModel", endpointId: element.endpoint.id, model })),
        "No models"
      );
    }

    if (element.kind === "connection") {
      const databases = await this.source.listDatabases(element.config);
      return this.withEmptyState(
        databases.map((db) => ({ kind: "database", connectionId: element.config.id, database: db })),
        "No databases"
      );
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
      return this.withEmptyState(items.map((s) => ({
        kind: "sqlItem",
        connectionId: element.connectionId,
        database: element.database,
        id: s.id,
        name: s.name,
        sql: s.sql
      })), "No saved SQL");
    }

    return [];
  }
}
