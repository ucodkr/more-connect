import * as vscode from "vscode";
// Run npm/yarn commands in the terminal so colors, status, and warnings are preserved.
export function runNpmOrYarnInTerminal(command: string, cwd?: string) {
  const terminal = vscode.window.createTerminal({
    name: `npm/yarn: ${command}`,
    cwd: cwd || undefined
  });
  terminal.show(true);
  terminal.sendText(command, true);
  vscode.window.showInformationMessage(`Command is running in the terminal: ${command}`);
}
import { createRequire } from "node:module";
import * as vscode from "vscode";
import type { OptionalModuleLoader } from "../db/factory";
import type { ConnectionStore } from "../storage";

export function logStoragePaths(
  output: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  store: ConnectionStore
): void {
  if (process.env.MORE_CONNECT_DEBUG !== "1") return;
  const drivers = vscode.Uri.joinPath(context.globalStorageUri, "drivers");
  const connectionsFolder = store.getFolderUri();
  const lines = [
    `[storage] globalStorageUri=${context.globalStorageUri.fsPath}`,
    `[storage] driversDir=${drivers.fsPath}`,
    `[storage] connectionsFolderUri=${connectionsFolder?.fsPath ?? "(not set; using VS Code globalState)"}`,
    `[storage] connectionsFile=${connectionsFolder ? vscode.Uri.joinPath(connectionsFolder, "more-connect-connections.json").fsPath : "(n/a)"}`
  ];
  for (const line of lines) output.appendLine(line);
}

export function createGlobalStorageModuleLoader(driversDirFsPath: string): OptionalModuleLoader {
  const base = driversDirFsPath.endsWith("/") ? driversDirFsPath : `${driversDirFsPath}/`;
  const requireFromDrivers = createRequire(`${base}package.json`);
  return {
    require: (id: string) => {
      try {
        return requireFromDrivers(id);
      } catch {
        // eslint-disable-next-line no-eval
        const req = (0, eval)("require") as (s: string) => any;
        return req(id);
      }
    }
  };
}

export async function showMissingDriverHelp(
  context: vscode.ExtensionContext,
  driversDirFsPath: string,
  message: string
): Promise<void> {
  const driver = message.split(":")[1]?.trim() || "driver";
  const cmd = `npm i --prefix "${driversDirFsPath}" ${driver}`;
  const choice = await vscode.window.showErrorMessage(
    `Missing driver "${driver}". Install it into this extension's global storage:\n${cmd}\nThen reload VS Code.`,
    "Copy install command",
    "Open global storage folder"
  );
  if (choice === "Copy install command") {
    await vscode.env.clipboard.writeText(cmd);
  } else if (choice === "Open global storage folder") {
    await vscode.commands.executeCommand("revealFileInOS", context.globalStorageUri);
  }
}
