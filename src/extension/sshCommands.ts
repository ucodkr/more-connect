import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { parseSshConfig, readUserSshConfigText, sshConnectionsFromConfig } from "../ssh/sshConfig";
import type { SshStore } from "../ssh/sshStore";
import type { ExplorerNode } from "../ui/explorerView";
import { SshFileExplorerPanel } from "../ui/sshFileExplorerPanel";

type RefreshableView = {
  refresh(node?: ExplorerNode): void;
};

type SshCommandsDeps = {
  sshStore: SshStore;
  view: RefreshableView;
};

function normalizeRemoteFolderPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (trimmed === "/" || trimmed === "~") return trimmed;
  return trimmed.replace(/\/+$/, "");
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

function buildRemoteLoginCommand(folder: string): string {
  const normalized = normalizeRemoteFolderPath(folder);
  if (!normalized) return "exec $SHELL -l";
  if (normalized === "/") return "cd / && exec $SHELL -l";
  if (normalized === "~") return "cd ~ && exec $SHELL -l";
  if (normalized.startsWith("~/")) {
    const rest = normalized.slice(2);
    return `cd ~ && cd -- ${shQuote(rest)} && exec $SHELL -l`;
  }
  return `cd -- ${shQuote(normalized)} && exec $SHELL -l`;
}

function updateConnectionFolders(
  items: Array<import("../types").SshConnection>,
  connectionId: string,
  updater: (current: string[]) => string[]
): Array<import("../types").SshConnection> {
  return items.map((connection) => {
    if (connection.id !== connectionId) return connection;
    const nextFolders = updater([...(connection.folders ?? [])]);
    return { ...connection, folders: nextFolders };
  });
}

function resolveFolderNodeFolder(node?: ExplorerNode): string | undefined {
  return node?.kind === "sshFolder" ? node.folder : undefined;
}

function resolveSshConnectionFromNode(
  sshStore: SshStore,
  node?: ExplorerNode
): import("../types").SshConnection | undefined {
  if (node?.kind === "ssh") return node.conn;
  if (node?.kind === "sshFolder") {
    return sshStore.list().find((connection) => connection.id === node.connectionId);
  }
  return undefined;
}

export function registerSshCommands(context: vscode.ExtensionContext, deps: SshCommandsDeps): void {
  const sshExplorer = new SshFileExplorerPanel(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.openSshTerminal", async (node?: ExplorerNode) => {
      const conn = resolveSshConnectionFromNode(deps.sshStore, node);
      if (!conn) return;
      const folder = node?.kind === "sshFolder" ? node.folder : "";
      const term = vscode.window.createTerminal({
        name: folder ? `SSH: ${conn.name} (${folder})` : `SSH: ${conn.name}`,
        location: { viewColumn: vscode.ViewColumn.Active }
      });
      term.show(false);
      term.sendText(folder ? `ssh -tt ${shQuote(conn.target)} ${shQuote(buildRemoteLoginCommand(folder))}` : `ssh -tt ${shQuote(conn.target)}`, true);
    }),

    vscode.commands.registerCommand("moreConnect.openSshFileExplorer", async (node?: ExplorerNode) => {
      const conn = resolveSshConnectionFromNode(deps.sshStore, node);
      if (!conn) return;
      const initialPath = resolveFolderNodeFolder(node);
      await sshExplorer.open(conn, initialPath);
    }),

    vscode.commands.registerCommand("moreConnect.addSshFolder", async (node?: ExplorerNode) => {
      const conn = resolveSshConnectionFromNode(deps.sshStore, node);
      if (!conn) return;
      const folder = await vscode.window.showInputBox({
        title: `Add folder to ${conn.name}`,
        prompt: "Remote folder path (e.g. /var/www, ~/projects/my-app)",
        value: conn.folders?.[0] ?? "/",
        ignoreFocusOut: true
      });
      if (folder === undefined) return;
      const normalized = normalizeRemoteFolderPath(folder);
      if (!normalized) return;
      const next = updateConnectionFolders(deps.sshStore.list(), conn.id, (folders) => {
        if (!folders.includes(normalized)) folders.push(normalized);
        return folders.sort((a, b) => a.localeCompare(b));
      });
      await deps.sshStore.saveAll(next);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeSshFolder", async (node?: ExplorerNode) => {
      const folder = resolveFolderNodeFolder(node);
      if (!folder || node?.kind !== "sshFolder") return;
      const next = updateConnectionFolders(deps.sshStore.list(), node.connectionId, (folders) => folders.filter((item) => item !== folder));
      await deps.sshStore.saveAll(next);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.openSshFolderInVsCode", async (node?: ExplorerNode) => {
      const conn = resolveSshConnectionFromNode(deps.sshStore, node);
      if (!conn) return;
      const folder = resolveFolderNodeFolder(node);
      if (!folder) return;
      const normalizedPath = folder.startsWith("/") ? folder : `/${folder}`;
      const uri = vscode.Uri.from({
        scheme: "vscode-remote",
        authority: `ssh-remote+${conn.target}`,
        path: normalizedPath
      });
      await vscode.commands.executeCommand("vscode.openFolder", uri, {
        forceNewWindow: true,
        forceReuseWindow: false
      });
    }),

    vscode.commands.registerCommand("moreConnect.importSshConfig", async () => {
      const text = await readUserSshConfigText();
      if (!text.trim()) {
        vscode.window.showInformationMessage("No ~/.ssh/config found (or empty).");
        return;
      }
      const imported = sshConnectionsFromConfig(parseSshConfig(text));
      if (imported.length === 0) {
        vscode.window.showInformationMessage("No concrete Host entries found in ~/.ssh/config.");
        return;
      }

      const existing = deps.sshStore.list();
      const existingTargets = new Set(existing.map((connection) => connection.target));
      const next = [...existing];
      let added = 0;
      for (const connection of imported) {
        if (existingTargets.has(connection.target)) continue;
        next.push({ ...connection, id: randomUUID() });
        added++;
      }
      await deps.sshStore.saveAll(next);
      deps.view.refresh();
      vscode.window.showInformationMessage(`Imported SSH hosts: +${added}`);
    }),

    vscode.commands.registerCommand("moreConnect.addSshConnection", async () => {
      const target = await vscode.window.showInputBox({
        title: "Add SSH connection",
        prompt: "Enter SSH target (e.g. my-alias, user@host, host -p 2222)",
        ignoreFocusOut: true
      });
      if (!target?.trim()) return;
      const name = await vscode.window.showInputBox({
        title: "Connection name",
        prompt: "Display name in the SSH view",
        value: target.trim(),
        ignoreFocusOut: true
      });
      if (!name?.trim()) return;
      const next = [...deps.sshStore.list(), { id: randomUUID(), name: name.trim(), target: target.trim(), folders: [] }];
      await deps.sshStore.saveAll(next);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.editSshConnection", async (node?: ExplorerNode) => {
      const conn = node?.kind === "ssh" ? node.conn : undefined;
      if (!conn) return;

      const target = await vscode.window.showInputBox({
        title: `Edit SSH connection: ${conn.name}`,
        prompt: "SSH target (e.g. my-alias, user@host, host -p 2222)",
        value: conn.target,
        ignoreFocusOut: true
      });
      if (target === undefined) return;

      const name = await vscode.window.showInputBox({
        title: `Edit SSH connection: ${conn.name}`,
        prompt: "Display name in the SSH view",
        value: conn.name,
        ignoreFocusOut: true
      });
      if (name === undefined) return;

      const updated = { ...conn, name: name.trim() || conn.name, target: target.trim() || conn.target, folders: conn.folders ?? [] };
      await deps.sshStore.saveAll(deps.sshStore.list().map((connection) => (connection.id === conn.id ? updated : connection)));
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeSshConnection", async (node?: ExplorerNode) => {
      const conn = node?.kind === "ssh" ? node.conn : undefined;
      if (!conn) return;
      await deps.sshStore.saveAll(deps.sshStore.list().filter((connection) => connection.id !== conn.id));
      deps.view.refresh();
    })
  );
}
