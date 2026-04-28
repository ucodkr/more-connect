import * as vscode from "vscode";
import { removeDockerContainer, removeDockerImage, startDockerContainer, stopDockerContainer, getDockerContainerLogs } from "../docker/dockerClient";
import { DockerLogsPanel } from "../ui/dockerLogsPanel";
import { ansiLinesToHtml, normalizeAnsiDisplayLine, stripAnsi } from "../ui/ansiToHtml";
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
  // Manage live log tailing.
  let tailingInterval: NodeJS.Timeout | undefined;
  let panelTailingInterval: NodeJS.Timeout | undefined;
  let lastLogs = "";
  // Tail logs when a container is selected.
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.tailDockerContainerLogs", async (node?: ExplorerNode) => {
      if (node?.kind !== "dockerContainer") return;
      const host = deps.dockerStore.list().find((item) => item.id === node.hostId);
      if (!host) return;
      // Use an OutputChannel for log output.
      const channelName = `Docker Logs: ${node.container.name || node.container.id}`;
      let channel = vscode.window.createOutputChannel(channelName);
      channel.show(true);
      // Stop existing tailing.
      if (tailingInterval) clearInterval(tailingInterval);
      lastLogs = "";
      // Refresh logs periodically.
      const fetchLogs = async () => {
        try {
          const logs = await getDockerContainerLogs(host, node.container.id, 2000);
          if (logs !== lastLogs) {
            channel.clear();
            channel.append(logs);
            lastLogs = logs;
          }
        } catch (err: any) {
          channel.appendLine("[ERROR] " + (err?.message || String(err)));
        }
      };
      await fetchLogs();
      tailingInterval = setInterval(fetchLogs, 2000);
      // Stop polling when the OutputChannel is closed.
      const closeListener = vscode.window.onDidChangeVisibleTextEditors((editors) => {
        if (!editors.some(e => e.document.fileName === channelName)) {
          if (tailingInterval) clearInterval(tailingInterval);
          closeListener.dispose();
        }
      });
    })
  );
  // Keep one log panel instance.
  const logsPanel = new DockerLogsPanel(context);
  vscode.commands.registerCommand("moreConnect.showDockerContainerLogs", async (node?: ExplorerNode) => {
    if (node?.kind !== "dockerContainer") return;
    const host = deps.dockerStore.list().find((item) => item.id === node.hostId);
    if (!host) return;
    const containerId = node.container.id;

    const fetchLogs = async () => {
      try {
        return await getDockerContainerLogs(host, containerId, 2000);
      } catch (err: any) {
        return err?.message || String(err);
      }
    };

    const toPayload = (logs: string) => {
      const rawLines = logs.length > 0 ? logs.split(/\r?\n/g) : [];
      return {
        containerId,
        rawLines: rawLines.map((line) => stripAnsi(normalizeAnsiDisplayLine(line))),
        htmlLines: ansiLinesToHtml(rawLines)
      };
    };

    const initialLogs = await fetchLogs();
    logsPanel.show(host, containerId, initialLogs);

    if (panelTailingInterval) {
      clearInterval(panelTailingInterval);
      panelTailingInterval = undefined;
    }

    const disposeSub = logsPanel.onDidDispose(() => {
      if (panelTailingInterval) {
        clearInterval(panelTailingInterval);
        panelTailingInterval = undefined;
      }
      disposeSub.dispose();
    });

    panelTailingInterval = setInterval(async () => {
      if (!logsPanel.isVisible()) {
        if (panelTailingInterval) {
          clearInterval(panelTailingInterval);
          panelTailingInterval = undefined;
        }
        return;
      }
      const nextLogs = await fetchLogs();
      logsPanel.postMessage({ type: "dockerLogs.setLogs", payload: toPayload(nextLogs) });
    }, 2000);
  }),
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
