import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SshConnection } from "../types";

type HostBlock = {
  patterns: string[];
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
};

export async function readUserSshConfigText(): Promise<string> {
  const file = path.join(os.homedir(), ".ssh", "config");
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return "";
  }
}

export function parseSshConfig(text: string): HostBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: HostBlock[] = [];
  let current: HostBlock | undefined;

  const commit = () => {
    if (current && current.patterns.length > 0) blocks.push(current);
    current = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, " ").trim();
    if (!line || line.startsWith("#")) continue;

    const mHost = /^Host\s+(.+)$/i.exec(line);
    if (mHost) {
      commit();
      current = { patterns: mHost[1].split(/\s+/).filter(Boolean) };
      continue;
    }

    if (!current) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === "hostname") current.hostName = value;
    else if (key === "user") current.user = value;
    else if (key === "port") {
      const port = Number(value);
      if (Number.isFinite(port)) current.port = port;
    } else if (key === "identityfile") {
      current.identityFile = value.replace(/^"(.+)"$/, "$1");
    }
  }
  commit();
  return blocks;
}

export function sshConnectionsFromConfig(blocks: HostBlock[]): SshConnection[] {
  const out: SshConnection[] = [];
  for (const b of blocks) {
    for (const p of b.patterns) {
      if (!p) continue;
      // Skip wildcard patterns by default; they are not concrete hosts.
      if (p.includes("*") || p.includes("?")) continue;
      const name = p;
      out.push({
        id: `sshcfg:${p}`,
        name,
        target: p,
        hostName: b.hostName,
        user: b.user,
        port: b.port,
        identityFile: b.identityFile
      });
    }
  }
  return out;
}

