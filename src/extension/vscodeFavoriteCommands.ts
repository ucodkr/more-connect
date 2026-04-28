import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { VsCodeFavoriteStore } from "../vscode/vscodeFavoriteStore";
import type { VsCodeFavorite } from "../types";
import type { ExplorerNode } from "../ui/explorerView";

type RefreshableView = {
  refresh(node?: ExplorerNode): void;
};

type VsCodeFavoriteCommandsDeps = {
  vsCodeFavoriteStore: VsCodeFavoriteStore;
  view: RefreshableView;
  currentWorkspaceToFavorite(): VsCodeFavorite | undefined;
  pathToVsCodeFavorite(rawPath: string): Promise<VsCodeFavorite | undefined>;
};

function favoriteUri(item: VsCodeFavorite): vscode.Uri {
  return item.kind === "remoteSsh" ? vscode.Uri.parse(item.targetPath, true) : vscode.Uri.file(item.targetPath);
}

function remoteSshUri(target: string, remotePath: string): vscode.Uri {
  const normalizedPath = remotePath.trim().startsWith("/") ? remotePath.trim() : `/${remotePath.trim()}`;
  return vscode.Uri.from({
    scheme: "vscode-remote",
    authority: `ssh-remote+${target.trim()}`,
    path: normalizedPath
  });
}

async function pickVsCodeFavorite(
  store: VsCodeFavoriteStore,
  node?: ExplorerNode
): Promise<VsCodeFavorite | undefined> {
  if (node?.kind === "vscodeFavorite") return node.favorite;
  const all = store.list();
  if (all.length === 0) {
    vscode.window.showInformationMessage("No VS Code favorites. Add one first.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    all.map((item) => ({
      label: item.name,
      description: item.kind,
      detail: item.targetPath,
      value: item
    })),
    { title: "Select VS Code favorite", ignoreFocusOut: true }
  );
  return picked?.value;
}

async function saveVsCodeFavorite(
  store: VsCodeFavoriteStore,
  view: RefreshableView,
  item: VsCodeFavorite
): Promise<void> {
  const all = store.list();
  if (all.some((x) => x.targetPath === item.targetPath && x.kind === item.kind)) {
    vscode.window.showInformationMessage("Already in VS Code favorites.");
    return;
  }
  await store.saveAll([...all, item]);
  view.refresh();
}

export function registerVsCodeFavoriteCommands(
  context: vscode.ExtensionContext,
  deps: VsCodeFavoriteCommandsDeps
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.addVsCodeFavorite", async () => {
      const source = await vscode.window.showQuickPick(
        [
          { label: "Current Workspace/Project", value: "current" as const },
          { label: "Select Folder", value: "folder" as const },
          { label: "Select Workspace File", value: "workspace" as const },
          { label: "Remote SSH Folder", value: "remoteSsh" as const },
          { label: "Input Path", value: "input" as const }
        ],
        { title: "Add VS Code favorite", ignoreFocusOut: true }
      );
      if (!source) return;

      let item: VsCodeFavorite | undefined;
      if (source.value === "current") {
        item = deps.currentWorkspaceToFavorite();
        if (!item) {
          vscode.window.showInformationMessage("No current workspace/project found.");
          return;
        }
      } else if (source.value === "folder") {
        const picked = await vscode.window.showOpenDialog({
          title: "Select folder",
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Add favorite"
        });
        if (!picked?.[0] || picked[0].scheme !== "file") return;
        item = {
          id: randomUUID(),
          name: path.basename(picked[0].fsPath) || picked[0].fsPath,
          targetPath: picked[0].fsPath,
          kind: "folder"
        };
      } else if (source.value === "workspace") {
        const picked = await vscode.window.showOpenDialog({
          title: "Select .code-workspace file",
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { "VS Code Workspace": ["code-workspace"] },
          openLabel: "Add favorite"
        });
        if (!picked?.[0] || picked[0].scheme !== "file") return;
        item = {
          id: randomUUID(),
          name: path.basename(picked[0].fsPath) || picked[0].fsPath,
          targetPath: picked[0].fsPath,
          kind: "workspace"
        };
      } else if (source.value === "remoteSsh") {
        const target = await vscode.window.showInputBox({
          title: "Remote SSH folder",
          prompt: "SSH target from Remote SSH or ~/.ssh/config",
          placeHolder: "user@192.168.0.1",
          ignoreFocusOut: true
        });
        if (target === undefined) return;
        const trimmedTarget = target.trim();
        if (!trimmedTarget) {
          vscode.window.showErrorMessage("SSH target is required.");
          return;
        }
        const remotePath = await vscode.window.showInputBox({
          title: "Remote SSH folder",
          prompt: "Remote folder path",
          value: "/",
          placeHolder: "/home/user/project",
          ignoreFocusOut: true
        });
        if (remotePath === undefined) return;
        const trimmedPath = remotePath.trim();
        if (!trimmedPath) {
          vscode.window.showErrorMessage("Remote folder path is required.");
          return;
        }
        const uri = remoteSshUri(trimmedTarget, trimmedPath);
        item = {
          id: randomUUID(),
          name: `${trimmedTarget}:${uri.path}`,
          targetPath: uri.toString(),
          kind: "remoteSsh"
        };
      } else {
        const input = await vscode.window.showInputBox({
          title: "Add VS Code favorite",
          prompt: "Folder path, .code-workspace file path, or vscode-remote://ssh-remote+host/path URI",
          ignoreFocusOut: true
        });
        if (input === undefined) return;
        item = await deps.pathToVsCodeFavorite(input);
      }
      if (!item) return;

      const nextName = await vscode.window.showInputBox({
        title: "Favorite name",
        prompt: "Display name in the VS Code favorites list",
        value: item.name,
        ignoreFocusOut: true
      });
      if (nextName === undefined) return;
      item.name = nextName.trim() || item.name;
      await saveVsCodeFavorite(deps.vsCodeFavoriteStore, deps.view, item);
    }),

    vscode.commands.registerCommand("moreConnect.editVsCodeFavorite", async (node?: ExplorerNode) => {
      const item = await pickVsCodeFavorite(deps.vsCodeFavoriteStore, node);
      if (!item) return;

      const nextPathInput = await vscode.window.showInputBox({
        title: `Edit VS Code favorite: ${item.name}`,
        prompt: "Folder path, .code-workspace file path, or vscode-remote://ssh-remote+host/path URI",
        value: item.targetPath,
        ignoreFocusOut: true
      });
      if (nextPathInput === undefined) return;
      const parsed = await deps.pathToVsCodeFavorite(nextPathInput);
      if (!parsed) return;

      const nextName = await vscode.window.showInputBox({
        title: `Edit VS Code favorite: ${item.name}`,
        prompt: "Display name",
        value: item.name,
        ignoreFocusOut: true
      });
      if (nextName === undefined) return;

      const updated: VsCodeFavorite = {
        id: item.id,
        kind: parsed.kind,
        targetPath: parsed.targetPath,
        name: nextName.trim() || item.name
      };
      await deps.vsCodeFavoriteStore.saveAll(
        deps.vsCodeFavoriteStore.list().map((x) => (x.id === item.id ? updated : x))
      );
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeVsCodeFavorite", async (node?: ExplorerNode) => {
      const item = await pickVsCodeFavorite(deps.vsCodeFavoriteStore, node);
      if (!item) return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove VS Code favorite "${item.name}"?`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") return;
      await deps.vsCodeFavoriteStore.saveAll(deps.vsCodeFavoriteStore.list().filter((x) => x.id !== item.id));
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.openVsCodeFavorite", async (node?: ExplorerNode) => {
      const item = await pickVsCodeFavorite(deps.vsCodeFavoriteStore, node);
      if (!item) return;
      const uri = favoriteUri(item);
      await vscode.commands.executeCommand("vscode.openFolder", uri, {
        forceNewWindow: true,
        forceReuseWindow: false
      });
    }),

    vscode.commands.registerCommand("moreConnect.openVsCodeFavoriteInFinder", async (node?: ExplorerNode) => {
      const item = await pickVsCodeFavorite(deps.vsCodeFavoriteStore, node);
      if (!item) return;
      if (item.kind === "remoteSsh") {
        vscode.window.showInformationMessage("Remote SSH favorites cannot be revealed in Finder.");
        return;
      }
      const uri = favoriteUri(item);
      await vscode.commands.executeCommand("revealFileInOS", uri);
    }),

    vscode.commands.registerCommand("moreConnect.openVsCodeFavoriteInTerminal", async (node?: ExplorerNode) => {
      const item = await pickVsCodeFavorite(deps.vsCodeFavoriteStore, node);
      if (!item) return;
      if (item.kind === "remoteSsh") {
        vscode.window.showInformationMessage("Open the Remote SSH favorite first, then use VS Code's integrated terminal.");
        return;
      }
      const cwd = item.kind === "workspace" ? path.dirname(item.targetPath) : item.targetPath;
      const terminal = vscode.window.createTerminal({ name: `Folder: ${item.name}`, cwd });
      terminal.show(true);
    })
  );
}
