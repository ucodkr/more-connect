import * as vscode from "vscode";
import * as cp from "child_process";
import * as util from "util";
import * as fs from "fs";

const execAsync = util.promisify(cp.exec);

async function ensureGitInit(folderPath: string, interactive: boolean = false): Promise<boolean> {
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  // Ignore drivers directory which could contain large binaries
  const gitignorePath = vscode.Uri.joinPath(vscode.Uri.file(folderPath), ".gitignore").fsPath;
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "drivers/\n");
  }

  const gitDir = vscode.Uri.joinPath(vscode.Uri.file(folderPath), ".git").fsPath;
  if (!fs.existsSync(gitDir)) {
    try {
      await execAsync("git init", { cwd: folderPath });
      
      try { await execAsync("git config user.name", { cwd: folderPath }); }
      catch { await execAsync('git config user.name "More Connect Sync"', { cwd: folderPath }); }
      try { await execAsync("git config user.email", { cwd: folderPath }); }
      catch { await execAsync('git config user.email "sync@more-connect.local"', { cwd: folderPath }); }

      if (interactive) {
        const remoteUrl = await vscode.window.showInputBox({
          prompt: "Enter Git Remote URL (leave empty for local-only)",
          ignoreFocusOut: true
        });
        if (remoteUrl) {
          await execAsync(`git remote add origin ${remoteUrl}`, { cwd: folderPath });
        }
      }
      await execAsync(`git branch -M main`, { cwd: folderPath });
      if (interactive) vscode.window.showInformationMessage("Git repository initialized.");
    } catch (err: any) {
      if (interactive) vscode.window.showErrorMessage(`Failed to initialize git: ${err.message}`);
      return false;
    }
  }
  return true;
}

async function hasGitRemote(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git remote", { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
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
    }),
    vscode.commands.registerCommand("moreConnect.gitPull", async () => {
      const storageFolderUri = deps.store.getFolderUri() ?? context.globalStorageUri;
      if (!storageFolderUri || !storageFolderUri.fsPath) {
        vscode.window.showErrorMessage("Storage folder is not a local file system folder.");
        return;
      }
      if (!(await ensureGitInit(storageFolderUri.fsPath, true))) return;
      if (!(await hasGitRemote(storageFolderUri.fsPath))) {
        vscode.window.showErrorMessage("No Git remote configured. Cannot pull.");
        return;
      }
      try {
        await execAsync("git pull --rebase --autostash origin main", { cwd: storageFolderUri.fsPath });
        vscode.window.showInformationMessage("Git pull successful.");
        deps.view.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Git pull failed: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand("moreConnect.gitPush", async () => {
      const storageFolderUri = deps.store.getFolderUri() ?? context.globalStorageUri;
      if (!storageFolderUri || !storageFolderUri.fsPath) {
        vscode.window.showErrorMessage("Storage folder is not a local file system folder.");
        return;
      }
      if (!(await ensureGitInit(storageFolderUri.fsPath, true))) return;
      try {
        await execAsync('git add . && git commit -m "Auto sync from More Connect" || true', { cwd: storageFolderUri.fsPath });
        if (await hasGitRemote(storageFolderUri.fsPath)) {
          await execAsync("git push -u origin HEAD", { cwd: storageFolderUri.fsPath });
          vscode.window.showInformationMessage("Git push successful.");
        } else {
          vscode.window.showInformationMessage("Git changes committed locally (no remote configured).");
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Git push failed: ${err.message}`);
      }
    })
  );

  // Background Auto-Sync every 5 minutes
  const autoSyncIntervalMs = 5 * 60 * 1000;
  
  // Also run an initial init on startup
  setTimeout(async () => {
    const storageFolderUri = deps.store.getFolderUri() ?? context.globalStorageUri;
    if (storageFolderUri && storageFolderUri.fsPath) {
      await ensureGitInit(storageFolderUri.fsPath, false);
    }
  }, 3000);

  setInterval(async () => {
    const storageFolderUri = deps.store.getFolderUri() ?? context.globalStorageUri;
    if (!storageFolderUri || !storageFolderUri.fsPath) return;
    try {
      const gitDir = vscode.Uri.joinPath(storageFolderUri, ".git").fsPath;
      if (fs.existsSync(gitDir)) {
        await execAsync('git add . && git commit -m "Auto sync" || true', { cwd: storageFolderUri.fsPath });
        if (await hasGitRemote(storageFolderUri.fsPath)) {
          await execAsync("git pull --rebase --autostash origin main", { cwd: storageFolderUri.fsPath });
          await execAsync("git push -u origin HEAD", { cwd: storageFolderUri.fsPath });
        }
      }
    } catch (e) {
      // Ignore background auto-sync errors (e.g. no remote, or network issues)
    }
  }, autoSyncIntervalMs);
}
