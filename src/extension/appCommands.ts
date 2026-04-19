import * as vscode from "vscode";
import type { ConnectionStore } from "../storage";
import type { DockerStore } from "../docker/dockerStore";
import type { OllamaStore } from "../ollama/ollamaStore";
import type { RestViewProvider } from "../rest/viewProvider";
import type { S3Store } from "../s3/s3Store";
import type { SshStore } from "../ssh/sshStore";
import type { VsCodeFavoriteStore } from "../vscode/vscodeFavoriteStore";
import type { WebLinkStore } from "../web/webLinkStore";
import type { ExplorerNode } from "../ui/explorerView";

type RefreshableView = {
  refresh(node?: ExplorerNode): void;
};

type AppCommandsDeps = {
  store: ConnectionStore;
  sshStore: SshStore;
  webLinkStore: WebLinkStore;
  dockerStore: DockerStore;
  s3Store: S3Store;
  vsCodeFavoriteStore: VsCodeFavoriteStore;
  ollamaStore: OllamaStore;
  restProvider: RestViewProvider;
  view: RefreshableView;
  extensionVersion: string;
};

export function registerAppCommands(context: vscode.ExtensionContext, deps: AppCommandsDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.refreshConnections", () => deps.view.refresh()),
    vscode.commands.registerCommand("moreConnect.showInfo", async () => {
      const storageFolderUri = deps.store.getFolderUri() ?? context.globalStorageUri;
      const storageFolder = storageFolderUri.fsPath;
      const info = [`version: ${deps.extensionVersion}`, `storage folder: ${storageFolder}`].join("\n");

      const choice = await vscode.window.showInformationMessage(info, "Copy", "Open Storage Folder");
      if (choice === "Copy") {
        await vscode.env.clipboard.writeText(info);
      } else if (choice === "Open Storage Folder") {
        await vscode.commands.executeCommand("revealFileInOS", storageFolderUri);
      }
    }),
    vscode.commands.registerCommand("moreConnect.showStoragePaths", async () => {
      const drivers = vscode.Uri.joinPath(context.globalStorageUri, "drivers");
      const info = [
        `globalStorageUri: ${context.globalStorageUri.fsPath}`,
        `driversDir: ${drivers.fsPath}`,
        `connectionsFolderUri(setting): ${deps.store.getFolderUri()?.fsPath ?? "(not set; using VS Code globalState)"}`,
        `connectionsFile(if set): ${
          deps.store.getFolderUri()
            ? vscode.Uri.joinPath(deps.store.getFolderUri()!, "more-connect-connections.json").fsPath
            : "(n/a)"
        }`,
        `sshFile(if set): ${vscode.Uri.joinPath(deps.sshStore.getFolderUri(), "more-connect-ssh.json").fsPath}`,
        `webLinksFile(if set): ${vscode.Uri.joinPath(deps.webLinkStore.getFolderUri(), "more-connect-web-links.json").fsPath}`,
        `dockerFile(if set): ${vscode.Uri.joinPath(deps.dockerStore.getFolderUri(), "more-connect-docker.json").fsPath}`,
        `s3File(if set): ${vscode.Uri.joinPath(deps.s3Store.getFolderUri(), "more-connect-s3.json").fsPath}`,
        `restFile(if set): ${vscode.Uri.joinPath(deps.store.getFolderUri() ?? context.globalStorageUri, "more.rest.json").fsPath}`,
        `vscodeFavoritesFile(if set): ${vscode.Uri.joinPath(deps.vsCodeFavoriteStore.getFolderUri(), "more-connect-vscode-favorites.json").fsPath}`,
        `ollamaFile(if set): ${vscode.Uri.joinPath(deps.ollamaStore.getFolderUri(), "more-connect-ollama.json").fsPath}`
      ].join("\n");

      const choice = await vscode.window.showInformationMessage(info, "Copy", "Open globalStorage");
      if (choice === "Copy") {
        await vscode.env.clipboard.writeText(info);
      } else if (choice === "Open globalStorage") {
        await vscode.commands.executeCommand("revealFileInOS", context.globalStorageUri);
      }
    }),
    vscode.commands.registerCommand("moreConnect.setConnectionsStorageFolder", async () => {
      const currentFolder = deps.store.getFolderUri() ?? context.globalStorageUri;
      const pick = await vscode.window.showOpenDialog({
        title: "Select folder to store connection info",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: currentFolder,
        openLabel: "Use this folder"
      });
      if (!pick?.[0]) return;
      await deps.store.setFolderUri(pick[0]);
      await deps.sshStore.setFolderUri(pick[0]);
      await deps.webLinkStore.setFolderUri(pick[0]);
      await deps.dockerStore.setFolderUri(pick[0]);
      await deps.s3Store.setFolderUri(pick[0]);
      await deps.vsCodeFavoriteStore.setFolderUri(pick[0]);
      await deps.ollamaStore.setFolderUri(pick[0]);
      await deps.restProvider.setGlobalStorageFolder(pick[0]);
      vscode.window.showInformationMessage(
        `Connection storage: ${vscode.Uri.joinPath(pick[0], "more-connect-connections.json").fsPath}`
      );
      deps.view.refresh();
    })
  );
}
