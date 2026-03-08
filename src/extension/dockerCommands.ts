import * as vscode from "vscode";
import { removeDockerContainer, removeDockerImage, startDockerContainer, stopDockerContainer } from "../docker/dockerClient";
import type { DockerStore } from "../docker/dockerStore";
import type { DockerHost } from "../types";
import type { ExplorerNode } from "../ui/explorerView";

type RefreshableView = {
  refresh(node?: ExplorerNode): void;
};

type DockerCommandsDeps = {
  dockerStore: DockerStore;
  view: RefreshableView;
  promptDockerHost(existing?: DockerHost): Promise<DockerHost | undefined>;
  quoteShellArg(value: string): string;
};

export function registerDockerCommands(context: vscode.ExtensionContext, deps: DockerCommandsDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.addDockerHost", async () => {
      const next = await deps.promptDockerHost();
      if (!next) return;
      await deps.dockerStore.saveAll([...deps.dockerStore.list(), next]);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.editDockerHost", async (node?: ExplorerNode) => {
      const host = node?.kind === "dockerHost" ? node.host : undefined;
      if (!host) return;
      const updated = await deps.promptDockerHost(host);
      if (!updated) return;
      await deps.dockerStore.saveAll(deps.dockerStore.list().map((item) => (item.id === host.id ? updated : item)));
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeDockerHost", async (node?: ExplorerNode) => {
      const host = node?.kind === "dockerHost" ? node.host : undefined;
      if (!host) return;
      const choice = await vscode.window.showWarningMessage(`Remove Docker host "${host.name}"?`, { modal: true }, "Remove");
      if (choice !== "Remove") return;
      await deps.dockerStore.saveAll(deps.dockerStore.list().filter((item) => item.id !== host.id));
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.refreshDockerHost", async () => {
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.openDockerContainerShell", async (node?: ExplorerNode) => {
      if (node?.kind !== "dockerContainer") return;
      const host = deps.dockerStore.list().find((item) => item.id === node.hostId);
      if (!host) return;
      const hostArg = deps.quoteShellArg(host.host);
      const containerArg = deps.quoteShellArg(node.container.id);
      const terminal = vscode.window.createTerminal({
        name: `Docker: ${node.container.name || node.container.id}`,
        location: { viewColumn: vscode.ViewColumn.Active }
      });
      terminal.show(false);
      terminal.sendText(
        `docker --host ${hostArg} exec -it ${containerArg} /bin/bash || docker --host ${hostArg} exec -it ${containerArg} /bin/sh`,
        true
      );
    }),

    vscode.commands.registerCommand("moreConnect.startDockerContainer", async (node?: ExplorerNode) => {
      if (node?.kind !== "dockerContainer") return;
      const host = deps.dockerStore.list().find((item) => item.id === node.hostId);
      if (!host) return;
      await startDockerContainer(host, node.container.id);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.stopDockerContainer", async (node?: ExplorerNode) => {
      if (node?.kind !== "dockerContainer") return;
      const host = deps.dockerStore.list().find((item) => item.id === node.hostId);
      if (!host) return;
      await stopDockerContainer(host, node.container.id);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeDockerContainer", async (node?: ExplorerNode) => {
      if (node?.kind !== "dockerContainer") return;
      const host = deps.dockerStore.list().find((item) => item.id === node.hostId);
      if (!host) return;
      const targetName = node.container.name || node.container.id;
      const choice = await vscode.window.showWarningMessage(`Force remove container "${targetName}"?`, { modal: true }, "Remove");
      if (choice !== "Remove") return;
      await removeDockerContainer(host, node.container.id);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeDockerImage", async (node?: ExplorerNode) => {
      if (node?.kind !== "dockerImage") return;
      const host = deps.dockerStore.list().find((item) => item.id === node.hostId);
      if (!host) return;
      const targetName = `${node.image.repository}:${node.image.tag}`;
      const choice = await vscode.window.showWarningMessage(`Force remove image "${targetName}"?`, { modal: true }, "Remove");
      if (choice !== "Remove") return;
      await removeDockerImage(host, node.image.id);
      deps.view.refresh();
    })
  );
}
