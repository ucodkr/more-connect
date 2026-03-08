import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { parseSshConfig, readUserSshConfigText, sshConnectionsFromConfig } from "../ssh/sshConfig";
import type { SshStore } from "../ssh/sshStore";
import type { ExplorerNode } from "../ui/explorerView";

type RefreshableView = {
  refresh(node?: ExplorerNode): void;
};

type SshCommandsDeps = {
  sshStore: SshStore;
  view: RefreshableView;
};

export function registerSshCommands(context: vscode.ExtensionContext, deps: SshCommandsDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.openSshTerminal", async (node?: ExplorerNode) => {
      const conn = node?.kind === "ssh" ? node.conn : undefined;
      if (!conn) return;
      const term = vscode.window.createTerminal({
        name: `SSH: ${conn.name}`,
        location: { viewColumn: vscode.ViewColumn.Active }
      });
      term.show(false);
      term.sendText(`ssh ${conn.target}`, true);
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
      const next = [...deps.sshStore.list(), { id: randomUUID(), name: name.trim(), target: target.trim() }];
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

      const updated = { ...conn, name: name.trim() || conn.name, target: target.trim() || conn.target };
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
