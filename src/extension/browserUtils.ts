import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { DockerHost, VsCodeFavorite } from "../types";

export function normalizeHttpUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = vscode.Uri.parse(candidate, true);
    if (!/^https?$/i.test(parsed.scheme)) return;
    return parsed.toString(true);
  } catch {
    return;
  }
}

export function normalizeDockerHost(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return;
  if (/^unix:\/\/\/.+/.test(trimmed)) return trimmed;
  if (/^ssh:\/\/.+/.test(trimmed)) return trimmed;
  if (/^tcp:\/\/.+/.test(trimmed)) return trimmed;
  return;
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function promptDockerHost(existing?: DockerHost): Promise<DockerHost | undefined> {
  const hostInput = await vscode.window.showInputBox({
    title: existing ? `Edit Docker host: ${existing.name}` : "Add Docker host",
    prompt: "Docker host (unix://, ssh://, tcp://)",
    value: existing?.host ?? "unix:///var/run/docker.sock",
    placeHolder: "unix:///var/run/docker.sock or ssh://user@host or tcp://host:2375",
    ignoreFocusOut: true
  });
  if (hostInput === undefined) return;
  const host = normalizeDockerHost(hostInput);
  if (!host) {
    vscode.window.showErrorMessage("Invalid Docker host. Use unix://, ssh://, or tcp://");
    return;
  }

  const defaultName = host === "unix:///var/run/docker.sock" ? "Local Docker" : host.replace(/^[a-z]+:\/\//i, "");
  const nameInput = await vscode.window.showInputBox({
    title: existing ? `Edit Docker host: ${existing.name}` : "Docker host name",
    prompt: "Display name in the Docker view",
    value: existing?.name ?? defaultName,
    ignoreFocusOut: true
  });
  if (nameInput === undefined) return;

  return {
    id: existing?.id ?? randomUUID(),
    name: nameInput.trim() || existing?.name || defaultName,
    host
  };
}

export async function openInternalBrowser(url: string): Promise<void> {
  await vscode.commands.executeCommand("simpleBrowser.show", url);
}

export async function previewMarkdownFile(uri?: vscode.Uri): Promise<void> {
  let target = uri;
  if (!target) {
    const active = vscode.window.activeTextEditor?.document;
    if (active && !active.isUntitled) target = active.uri;
  }
  if (!target) {
    vscode.window.showInformationMessage("Select a .md file first.");
    return;
  }

  const ext = path.extname(target.fsPath || target.path).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") {
    vscode.window.showErrorMessage("Only .md/.markdown files are supported.");
    return;
  }

  await vscode.commands.executeCommand("vscode.open", target);
  await vscode.commands.executeCommand("markdown.showPreviewToSide", target);
}

function normalizeUserPathInput(input: string): string | undefined {
  const trimmed = input.trim().replace(/^['"]+|['"]+$/g, "");
  return trimmed || undefined;
}

function buildVsCodeFavoriteName(targetPath: string): string {
  if (targetPath.startsWith("vscode-remote://")) {
    const uri = vscode.Uri.parse(targetPath);
    const base = path.posix.basename(uri.path);
    return base || uri.authority || targetPath;
  }
  const base = path.basename(targetPath);
  return base || targetPath;
}

export async function pathToVsCodeFavorite(rawPath: string): Promise<VsCodeFavorite | undefined> {
  const targetPath = normalizeUserPathInput(rawPath);
  if (!targetPath) return;
  if (targetPath.startsWith("vscode-remote://")) {
    const uri = vscode.Uri.parse(targetPath, true);
    if (uri.scheme === "vscode-remote" && uri.authority.startsWith("ssh-remote+") && uri.path) {
      return {
        id: randomUUID(),
        name: buildVsCodeFavoriteName(targetPath),
        targetPath: uri.toString(),
        kind: "remoteSsh"
      };
    }
    vscode.window.showErrorMessage("Invalid Remote SSH URI. Use vscode-remote://ssh-remote+host/path.");
    return;
  }
  const targetUri = vscode.Uri.file(targetPath);
  try {
    const stat = await vscode.workspace.fs.stat(targetUri);
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      return {
        id: randomUUID(),
        name: buildVsCodeFavoriteName(targetPath),
        targetPath,
        kind: "folder"
      };
    }
    const lower = targetPath.toLowerCase();
    if ((stat.type & vscode.FileType.File) !== 0 && lower.endsWith(".code-workspace")) {
      return {
        id: randomUUID(),
        name: buildVsCodeFavoriteName(targetPath),
        targetPath,
        kind: "workspace"
      };
    }
    vscode.window.showErrorMessage("Only folders and .code-workspace files are supported.");
    return;
  } catch {
    vscode.window.showErrorMessage(`Path not found: ${targetPath}`);
    return;
  }
}

export function currentWorkspaceToFavorite(): VsCodeFavorite | undefined {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile?.scheme === "file") {
    const targetPath = workspaceFile.fsPath;
    return {
      id: randomUUID(),
      name: buildVsCodeFavoriteName(targetPath),
      targetPath,
      kind: "workspace"
    };
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") return;
  const targetPath = folder.uri.fsPath;
  return {
    id: randomUUID(),
    name: buildVsCodeFavoriteName(targetPath),
    targetPath,
    kind: "folder"
  };
}

export function normalizeOllamaUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = vscode.Uri.parse(candidate, true);
    if (!/^https?$/i.test(parsed.scheme) || !parsed.authority) return;
    const normalized = `${parsed.scheme}://${parsed.authority}${parsed.path}`.replace(/\/+$/, "");
    return normalized || `${parsed.scheme}://${parsed.authority}`;
  } catch {
    return;
  }
}
