import * as vscode from "vscode";
import type { RestViewProvider } from "../rest/viewProvider";
import type { ExplorerNode } from "../ui/explorerView";

type RestCommandsDeps = {
  restProvider: RestViewProvider;
};

export function registerRestCommands(context: vscode.ExtensionContext, deps: RestCommandsDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.openRestClient", async () => {
      await deps.restProvider.reveal();
    }),
    vscode.commands.registerCommand("moreConnect.openRestEnvironments", async () => {
      await deps.restProvider.openEnvironments();
    }),
    vscode.commands.registerCommand("moreConnect.importRestData", async () => {
      await deps.restProvider.importData();
    }),
    vscode.commands.registerCommand("moreConnect.exportRestData", async () => {
      await deps.restProvider.exportData();
    }),
    vscode.commands.registerCommand("moreConnect.addRestCollection", async () => {
      await deps.restProvider.newCollection();
    }),
    vscode.commands.registerCommand("moreConnect.addRestFolder", async (node?: ExplorerNode) => {
      if (node?.kind === "restCollection") {
        await deps.restProvider.newFolder(node.collection.id);
        return;
      }
      if (node?.kind === "restFolder") {
        await deps.restProvider.newFolder(node.collectionId, node.folder.id);
      }
    }),
    vscode.commands.registerCommand("moreConnect.addRestRequest", async (node?: ExplorerNode) => {
      if (!node || node.kind === "group") {
        await deps.restProvider.newRequest();
        return;
      }
      if (node.kind === "restCollection") {
        await deps.restProvider.newRequest(node.collection.id);
        return;
      }
      if (node.kind === "restFolder") {
        await deps.restProvider.newRequest(node.collectionId, node.folder.id);
      }
    }),
    vscode.commands.registerCommand("moreConnect.openRestRequest", async (node?: ExplorerNode) => {
      if (node?.kind !== "restRequest") return;
      await deps.restProvider.openRequest(node.request.id);
    }),
    vscode.commands.registerCommand("moreConnect.duplicateRestCollection", async (node?: ExplorerNode) => {
      if (node?.kind !== "restCollection") return;
      await deps.restProvider.duplicateCollection(node.collection.id);
    }),
    vscode.commands.registerCommand("moreConnect.renameRestCollection", async (node?: ExplorerNode) => {
      if (node?.kind !== "restCollection") return;
      await deps.restProvider.renameCollection(node.collection.id, node.collection.name);
    }),
    vscode.commands.registerCommand("moreConnect.duplicateRestRequest", async (node?: ExplorerNode) => {
      if (node?.kind !== "restRequest") return;
      await deps.restProvider.duplicateRequest(node.request.id);
    }),
    vscode.commands.registerCommand("moreConnect.renameRestRequest", async (node?: ExplorerNode) => {
      if (node?.kind !== "restRequest") return;
      await deps.restProvider.renameRequest(node.request.id, node.request.name);
    }),
    vscode.commands.registerCommand("moreConnect.duplicateRestFolder", async (node?: ExplorerNode) => {
      if (node?.kind !== "restFolder") return;
      await deps.restProvider.duplicateFolder(node.collectionId, node.folder.id);
    }),
    vscode.commands.registerCommand("moreConnect.renameRestFolder", async (node?: ExplorerNode) => {
      if (node?.kind !== "restFolder") return;
      await deps.restProvider.renameFolder(node.collectionId, node.folder.id, node.folder.name);
    }),
    vscode.commands.registerCommand("moreConnect.removeRestItem", async (node?: ExplorerNode) => {
      if (!node) return;
      if (node.kind === "restCollection") {
        await deps.restProvider.deleteItem(node.collection.id, node.collection.name);
        return;
      }
      if (node.kind === "restFolder") {
        await deps.restProvider.deleteItem(node.folder.id, node.folder.name);
        return;
      }
      if (node.kind === "restRequest") {
        await deps.restProvider.deleteItem(node.request.id, node.request.name);
      }
    })
  );
}
