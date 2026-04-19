import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as vscode from "vscode";
import type { S3Host, S3Provider } from "../types";
import type { ExplorerNode } from "../ui/explorerView";
import { createFolder, deleteObject, deletePrefixRecursive, downloadObjectToFile, listKeysRecursive, uploadFile, uploadFileAsKey } from "../s3/s3Client";
import type { S3Store } from "../s3/s3Store";

type RefreshableView = {
  refresh(node?: ExplorerNode): void;
};

type S3CommandsDeps = {
  s3Store: S3Store;
  view: RefreshableView;
};

function providerLabel(provider: S3Provider): string {
  return provider === "aws" ? "AWS S3" : provider === "minio" ? "MinIO" : "S3 Compatible";
}

function normalizeUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    return u.toString().replace(/\/$/, "");
  } catch {
    return;
  }
}

async function promptS3Host(deps: S3CommandsDeps, existing?: S3Host): Promise<{ host: S3Host; secretAccessKey: string; sessionToken?: string } | undefined> {
  const providerPick = await vscode.window.showQuickPick(
    [
      { label: "AWS S3", provider: "aws" as const },
      { label: "MinIO", provider: "minio" as const },
      { label: "S3 Compatible", provider: "s3compatible" as const }
    ],
    { title: existing ? `Edit S3 host (${existing.name})` : "Add S3 host", ignoreFocusOut: true }
  );
  if (!providerPick) return;

  const provider = providerPick.provider;
  const name = await vscode.window.showInputBox({
    title: existing ? `S3 host name (${providerLabel(provider)})` : `S3 host name (${providerLabel(provider)})`,
    prompt: "Display name in the S3 Browser",
    value: existing?.name ?? "",
    ignoreFocusOut: true
  });
  if (name === undefined) return;
  if (!name.trim()) return;

  const endpointRequired = provider !== "aws";
  const endpointInput = await vscode.window.showInputBox({
    title: `Endpoint URL ${endpointRequired ? "(required)" : "(optional)"}`,
    prompt: endpointRequired ? "e.g. http://localhost:9000" : "Leave empty for AWS default endpoint",
    value: existing?.endpointUrl ?? "",
    ignoreFocusOut: true
  });
  if (endpointInput === undefined) return;
  const endpointUrl = endpointInput.trim() ? normalizeUrl(endpointInput) : undefined;
  if (endpointRequired && !endpointUrl) {
    vscode.window.showErrorMessage("Invalid endpoint URL (use http:// or https://).");
    return;
  }

  const region = await vscode.window.showInputBox({
    title: "Region",
    prompt: "e.g. us-east-1",
    value: existing?.region ?? "us-east-1",
    ignoreFocusOut: true
  });
  if (region === undefined) return;
  if (!region.trim()) return;

  const accessKeyId = await vscode.window.showInputBox({
    title: "Access Key ID",
    prompt: "AWS accessKeyId / MinIO access key",
    value: existing?.accessKeyId ?? "",
    ignoreFocusOut: true
  });
  if (accessKeyId === undefined) return;
  if (!accessKeyId.trim()) return;

  const existingSecret = existing ? await deps.s3Store.getSecret(existing.id) : undefined;
  const secretAccessKeyInput = await vscode.window.showInputBox({
    title: "Secret Access Key",
    prompt: existing ? "Leave empty to keep existing secret" : "Required",
    password: true,
    ignoreFocusOut: true
  });
  if (secretAccessKeyInput === undefined) return;
  const secretAccessKey = secretAccessKeyInput.trim() ? secretAccessKeyInput : existingSecret?.secretAccessKey;
  if (!secretAccessKey) return;

  const sessionTokenInput = await vscode.window.showInputBox({
    title: "Session Token (optional)",
    prompt: existing ? "Leave empty to keep existing token" : "Optional",
    password: true,
    ignoreFocusOut: true
  });
  if (sessionTokenInput === undefined) return;
  const sessionToken = sessionTokenInput.trim() ? sessionTokenInput : existingSecret?.sessionToken;

  let forcePathStyle = existing?.forcePathStyle;
  if (provider === "minio") {
    forcePathStyle = true;
  } else if (provider !== "aws") {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Path-style (recommended)", value: true },
        { label: "Virtual-hosted-style", value: false }
      ],
      { title: "Addressing mode", ignoreFocusOut: true }
    );
    if (!pick) return;
    forcePathStyle = pick.value;
  } else {
    forcePathStyle = undefined;
  }

  const host: S3Host = {
    id: existing?.id ?? randomUUID(),
    name: name.trim(),
    provider,
    endpointUrl,
    region: region.trim(),
    accessKeyId: accessKeyId.trim(),
    forcePathStyle
  };
  return { host, secretAccessKey, sessionToken };
}

async function getHostAndCreds(deps: S3CommandsDeps, hostId: string): Promise<{ host: S3Host; secretAccessKey: string; sessionToken?: string } | undefined> {
  const host = deps.s3Store.list().find((h) => h.id === hostId);
  if (!host) return;
  const secret = await deps.s3Store.getSecret(host.id);
  if (!secret?.secretAccessKey) {
    vscode.window.showErrorMessage(`Missing secret for S3 host "${host.name}". Edit host to set credentials.`);
    return;
  }
  return { host, secretAccessKey: secret.secretAccessKey, sessionToken: secret.sessionToken };
}

async function collectLocalFiles(rootFolderFsPath: string): Promise<Array<{ absPath: string; relPath: string }>> {
  const out: Array<{ absPath: string; relPath: string }> = [];

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = relative(rootFolderFsPath, absPath).split("\\").join("/");
      out.push({ absPath, relPath });
    }
  }

  await walk(rootFolderFsPath);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function basenameFromKey(key: string): string {
  const parts = key.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : key;
}

function normalizePrefix(prefix: string): string {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function encodePathPreserveSlash(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function makeS3Uri(bucket: string, keyOrPrefix: string): string {
  const clean = keyOrPrefix.replace(/^\/+/, "");
  return `s3://${bucket}/${clean}`;
}

function makeHttpUrl(host: S3Host, bucket: string, keyOrPrefix: string): string | undefined {
  const rawKey = keyOrPrefix.replace(/^\/+/, "");
  const key = encodePathPreserveSlash(rawKey);

  if (host.endpointUrl) {
    const endpoint = host.endpointUrl.replace(/\/+$/, "");
    const u = new URL(endpoint);
    if (host.forcePathStyle === true) {
      return `${endpoint}/${encodeURIComponent(bucket)}/${key}`;
    }
    const baseHost = u.host;
    return `${u.protocol}//${encodeURIComponent(bucket)}.${baseHost}/${key}`;
  }

  if (host.provider === "aws") {
    const region = host.region || "us-east-1";
    return `https://${encodeURIComponent(bucket)}.s3.${encodeURIComponent(region)}.amazonaws.com/${key}`;
  }

  return;
}

export function registerS3Commands(context: vscode.ExtensionContext, deps: S3CommandsDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.uploadS3", async (node?: ExplorerNode) => {
      if (!node || (node.kind !== "s3Bucket" && node.kind !== "s3Prefix")) return;
      const picked = await vscode.window.showQuickPick(
        [
          { label: "Upload File", value: "file" as const },
          { label: "Upload Folder", value: "folder" as const }
        ],
        { title: "Upload to S3", ignoreFocusOut: true }
      );
      if (!picked) return;
      if (picked.value === "file") {
        await vscode.commands.executeCommand("moreConnect.uploadS3File", node);
        return;
      }
      await vscode.commands.executeCommand("moreConnect.uploadS3Folder", node);
    }),

    vscode.commands.registerCommand("moreConnect.copyS3Link", async (node?: ExplorerNode) => {
      if (!node || (node.kind !== "s3Object" && node.kind !== "s3Prefix" && node.kind !== "s3Bucket")) return;
      const target = await getHostAndCreds(deps, node.hostId);
      if (!target) return;

      const bucket = node.bucket;
      const keyOrPrefix = node.kind === "s3Object" ? node.key : node.kind === "s3Prefix" ? node.prefix : "";
      const s3Uri = node.kind === "s3Bucket" ? `s3://${bucket}` : makeS3Uri(bucket, keyOrPrefix);
      const httpUrl = node.kind === "s3Bucket" ? undefined : makeHttpUrl(target.host, bucket, keyOrPrefix);

      const picks: Array<{ label: string; value: string }> = [];
      if (httpUrl) picks.push({ label: "HTTPS URL", value: httpUrl });
      picks.push({ label: "S3 URI", value: s3Uri });

      const chosen = picks.length === 1 ? picks[0] : await vscode.window.showQuickPick(picks, { title: "Copy link", ignoreFocusOut: true });
      if (!chosen) return;

      await vscode.env.clipboard.writeText(chosen.value);
      vscode.window.showInformationMessage("Copied link to clipboard.");
    }),

    vscode.commands.registerCommand("moreConnect.addS3Host", async () => {
      const res = await promptS3Host(deps);
      if (!res) return;
      await deps.s3Store.saveAll([...deps.s3Store.list(), res.host]);
      await deps.s3Store.setSecret(res.host.id, { secretAccessKey: res.secretAccessKey, sessionToken: res.sessionToken });
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.editS3Host", async (node?: ExplorerNode) => {
      const host = node?.kind === "s3Host" ? node.host : undefined;
      if (!host) return;
      const res = await promptS3Host(deps, host);
      if (!res) return;
      await deps.s3Store.saveAll(deps.s3Store.list().map((h) => (h.id === host.id ? res.host : h)));
      await deps.s3Store.setSecret(res.host.id, { secretAccessKey: res.secretAccessKey, sessionToken: res.sessionToken });
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeS3Host", async (node?: ExplorerNode) => {
      const host = node?.kind === "s3Host" ? node.host : undefined;
      if (!host) return;
      const choice = await vscode.window.showWarningMessage(`Remove S3 host "${host.name}"?`, { modal: true }, "Remove");
      if (choice !== "Remove") return;
      await deps.s3Store.saveAll(deps.s3Store.list().filter((h) => h.id !== host.id));
      await deps.s3Store.deleteSecret(host.id);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.refreshS3", async () => {
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.uploadS3File", async (node?: ExplorerNode) => {
      if (!node || (node.kind !== "s3Bucket" && node.kind !== "s3Prefix")) return;
      const target = await getHostAndCreds(deps, node.hostId);
      if (!target) return;
      const pick = await vscode.window.showOpenDialog({
        title: "Select file to upload",
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Upload"
      });
      if (!pick?.[0]) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Uploading to S3...", cancellable: false },
        async () => {
          await uploadFile(
            target.host,
            { accessKeyId: target.host.accessKeyId, secretAccessKey: target.secretAccessKey, sessionToken: target.sessionToken },
            node.bucket,
            node.kind === "s3Prefix" ? node.prefix : "",
            pick[0].fsPath
          );
        }
      );
      deps.view.refresh(node);
    }),

    vscode.commands.registerCommand("moreConnect.createS3Folder", async (node?: ExplorerNode) => {
      if (!node || (node.kind !== "s3Bucket" && node.kind !== "s3Prefix")) return;
      const target = await getHostAndCreds(deps, node.hostId);
      if (!target) return;
      const name = await vscode.window.showInputBox({
        title: "Create folder",
        prompt: "Folder name (no leading /)",
        ignoreFocusOut: true
      });
      if (name === undefined) return;
      if (!name.trim()) return;
      const parentPrefix = node.kind === "s3Prefix" ? node.prefix : "";
      await createFolder(
        target.host,
        { accessKeyId: target.host.accessKeyId, secretAccessKey: target.secretAccessKey, sessionToken: target.sessionToken },
        node.bucket,
        parentPrefix,
        name.trim()
      );
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.uploadS3Folder", async (node?: ExplorerNode) => {
      if (!node || (node.kind !== "s3Bucket" && node.kind !== "s3Prefix")) return;
      const target = await getHostAndCreds(deps, node.hostId);
      if (!target) return;
      const pick = await vscode.window.showOpenDialog({
        title: "Select folder to upload",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Upload"
      });
      if (!pick?.[0]) return;
      const rootFolder = pick[0].fsPath;
      const files = await collectLocalFiles(rootFolder);
      if (files.length === 0) {
        vscode.window.showInformationMessage("No files found in folder.");
        return;
      }

      const prefix = node.kind === "s3Prefix" ? node.prefix : "";
      const keyPrefix = prefix ? (prefix.endsWith("/") ? prefix : `${prefix}/`) : "";

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Uploading folder to S3...", cancellable: false },
        async (progress) => {
          const total = files.length;
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            progress.report({ message: `${i + 1}/${total} ${f.relPath}` });
            await uploadFileAsKey(
              target.host,
              { accessKeyId: target.host.accessKeyId, secretAccessKey: target.secretAccessKey, sessionToken: target.sessionToken },
              node.bucket,
              `${keyPrefix}${f.relPath}`,
              f.absPath
            );
          }
        }
      );
      deps.view.refresh(node);
    }),

    vscode.commands.registerCommand("moreConnect.deleteS3Object", async (node?: ExplorerNode) => {
      if (!node || node.kind !== "s3Object") return;
      const target = await getHostAndCreds(deps, node.hostId);
      if (!target) return;
      const choice = await vscode.window.showWarningMessage(`Delete file "${node.name}"?`, { modal: true }, "Delete");
      if (choice !== "Delete") return;
      await deleteObject(
        target.host,
        { accessKeyId: target.host.accessKeyId, secretAccessKey: target.secretAccessKey, sessionToken: target.sessionToken },
        node.bucket,
        node.key
      );
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.downloadS3Object", async (node?: ExplorerNode) => {
      if (!node || node.kind !== "s3Object") return;
      const target = await getHostAndCreds(deps, node.hostId);
      if (!target) return;
      const defaultName = basenameFromKey(node.key);
      const saveUri = await vscode.window.showSaveDialog({
        title: "Save S3 file as",
        defaultUri: vscode.Uri.file(defaultName),
        saveLabel: "Download"
      });
      if (!saveUri) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Downloading from S3...", cancellable: false },
        async () => {
          await fs.mkdir(dirname(saveUri.fsPath), { recursive: true });
          await downloadObjectToFile(
            target.host,
            { accessKeyId: target.host.accessKeyId, secretAccessKey: target.secretAccessKey, sessionToken: target.sessionToken },
            node.bucket,
            node.key,
            saveUri.fsPath
          );
        }
      );
      vscode.window.showInformationMessage(`Downloaded: ${saveUri.fsPath}`);
    }),

    vscode.commands.registerCommand("moreConnect.downloadS3Folder", async (node?: ExplorerNode) => {
      if (!node || node.kind !== "s3Prefix") return;
      const target = await getHostAndCreds(deps, node.hostId);
      if (!target) return;
      const destPick = await vscode.window.showOpenDialog({
        title: "Select destination folder",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Download here"
      });
      if (!destPick?.[0]) return;

      const destRoot = destPick[0].fsPath;
      const prefix = normalizePrefix(node.prefix);
      const files = await listKeysRecursive(
        target.host,
        { accessKeyId: target.host.accessKeyId, secretAccessKey: target.secretAccessKey, sessionToken: target.sessionToken },
        node.bucket,
        prefix
      );
      if (files.length === 0) {
        vscode.window.showInformationMessage("No files found in folder.");
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Downloading folder from S3...", cancellable: false },
        async (progress) => {
          const total = files.length;
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const rel = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key;
            const targetPath = join(destRoot, rel);
            progress.report({ message: `${i + 1}/${total} ${rel}` });
            await fs.mkdir(dirname(targetPath), { recursive: true });
            await downloadObjectToFile(
              target.host,
              { accessKeyId: target.host.accessKeyId, secretAccessKey: target.secretAccessKey, sessionToken: target.sessionToken },
              node.bucket,
              f.key,
              targetPath
            );
          }
        }
      );
      vscode.window.showInformationMessage(`Downloaded folder to: ${destRoot}`);
    }),

    vscode.commands.registerCommand("moreConnect.deleteS3Folder", async (node?: ExplorerNode) => {
      if (!node || node.kind !== "s3Prefix") return;
      const target = await getHostAndCreds(deps, node.hostId);
      if (!target) return;
      const choice = await vscode.window.showWarningMessage(`Delete folder "${node.name}" (recursive)?`, { modal: true }, "Delete");
      if (choice !== "Delete") return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Deleting S3 folder...", cancellable: false },
        async () => {
          await deletePrefixRecursive(
            target.host,
            { accessKeyId: target.host.accessKeyId, secretAccessKey: target.secretAccessKey, sessionToken: target.sessionToken },
            node.bucket,
            node.prefix
          );
        }
      );
      deps.view.refresh();
    })
  );
}
