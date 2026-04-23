import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createSystemSsh, type SystemSsh } from "../ssh/systemSsh";
import type { SshConnection } from "../types";
import { renderWebviewAppHtml } from "./webviewAppShell";

type DirEntry = {
  name: string;
  isDir: boolean;
  size: number;
  owner: string;
  group: string;
  permNum: string;
  permText: string;
};

function posixNormalize(p: string): string {
  const norm = path.posix.normalize(p || "/");
  if (norm === ".") return "/";
  return norm;
}

function renderHtml(title: string, webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "codicons", "codicon.css"));
  return renderWebviewAppHtml({
    webview,
    extensionUri,
    title,
    scriptFile: "sshExplorerApp.js",
    stylesheets: [String(codiconCssUri)],
    state: { title }
  });
}

export class SshFileExplorerPanel {
  private panel: vscode.WebviewPanel | undefined;
  private onMessageSub: vscode.Disposable | undefined;
  private system: SystemSsh | undefined;
  private conn: SshConnection | undefined;
  private cwd: string | undefined;
  private refreshSeq = 0;
  private webviewReady = false;
  private lastStatus: string | undefined;
  private lastDir: { cwd: string; entries: DirEntry[] } | undefined;

  public constructor(private readonly ctx: vscode.ExtensionContext) { }

  public async open(conn: SshConnection): Promise<void> {
    this.conn = conn;
    this.system = createSystemSsh(conn);
    this.cwd = undefined;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "moreConnect.sshExplorer",
        "More Connect: SSH Explorer",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")]
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.onMessageSub?.dispose();
        this.onMessageSub = undefined;
      });
      this.onMessageSub = this.panel.webview.onDidReceiveMessage(async (msg) => {
        const activeConn = this.conn;
        if (!activeConn) return;
        const timeoutMs = vscode.workspace.getConfiguration().get<number>("moreConnect.connectionTimeoutMs", 15000);
        try {
          await this.handleMessage(msg, timeoutMs);
        } catch (e: any) {
          this.postStatus(String(e?.message ?? e ?? "Unknown error"));
        }
      });
    }

    this.panel.title = `SSH Explorer: ${conn.name}`;
    this.panel.webview.html = renderHtml(`SSH Explorer: ${conn.name}`, this.panel.webview, this.ctx.extensionUri);
    this.webviewReady = false;

    // Auto-load home directory using system ssh (non-interactive).
    const timeoutMs = vscode.workspace.getConfiguration().get<number>("moreConnect.connectionTimeoutMs", 15000);
    await this.refresh(timeoutMs, "~");
  }

  private postStatus(text: string): void {
    this.lastStatus = text;
    try {
      if (!this.webviewReady) return;
      this.panel?.webview.postMessage({ type: "sshExplorer.status", text });
    } catch { }
  }

  private postDir(entries: DirEntry[]): void {
    this.lastDir = { cwd: this.cwd ?? "", entries };
    try {
      if (!this.webviewReady) return;
      this.panel?.webview.postMessage({ type: "sshExplorer.dir", cwd: this.cwd ?? "", entries });
    } catch { }
  }

  private async handleMessage(msg: any, timeoutMs: number): Promise<void> {
    const type = msg?.type;
    if (type === "sshExplorer.ready") {
      this.webviewReady = true;
      if (this.lastStatus) this.postStatus(this.lastStatus);
      if (this.lastDir) {
        try {
          this.panel?.webview.postMessage({ type: "sshExplorer.dir", cwd: this.lastDir.cwd, entries: this.lastDir.entries });
        } catch { }
      }
      return;
    }
    if (type === "sshExplorer.refresh") {
      await this.refresh(timeoutMs, String(msg?.path ?? ""));
      return;
    }
    if (type === "sshExplorer.up") {
      if (!this.cwd) {
        this.postStatus("먼저 절대경로를 입력하고 Refresh 하세요.");
        this.postDir([]);
        return;
      }
      const parent = posixNormalize(path.posix.dirname(this.cwd));
      await this.listAtPath(parent, timeoutMs);
      return;
    }
    if (type === "sshExplorer.cd") {
      const raw = String(msg?.path ?? "");
      if (!raw.trim()) return;
      const target = this.resolveTargetPath(raw);
      if (!target) return;
      await this.listAtPath(target, timeoutMs);
      return;
    }
    if (type === "sshExplorer.openDir") {
      const name = String(msg?.name ?? "");
      if (!name) return;
      if (!this.cwd) {
        this.postStatus("먼저 절대경로를 입력하고 Refresh 하세요.");
        this.postDir([]);
        return;
      }
      const target = posixNormalize(path.posix.join(this.cwd, name));
      await this.listAtPath(target, timeoutMs);
      return;
    }
    if (type === "sshExplorer.download") {
      const name = String(msg?.name ?? "");
      if (!name) return;
      await this.downloadFile(name, timeoutMs);
      return;
    }
    if (type === "sshExplorer.view") {
      const name = String(msg?.name ?? "");
      if (!name) return;
      await this.viewFile(name, timeoutMs);
      return;
    }
    if (type === "sshExplorer.delete") {
      const name = String(msg?.name ?? "");
      const isDir = Boolean(msg?.isDir);
      if (!name) return;
      await this.deleteEntry(name, isDir, timeoutMs);
    }
  }

  private shQuote(s: string): string {
    return `'${s.replaceAll("'", `'\"'\"'`)}'`;
  }

  private resolveTargetPath(input: string): string | undefined {
    const s = String(input ?? "");
    const trimmed = s.trim();
    if (!trimmed) return;

    // Absolute
    if (trimmed.startsWith("/")) return posixNormalize(trimmed);

    // Home shortcuts: resolve on remote; UI will update to absolute via pwd.
    if (trimmed === "~" || trimmed.startsWith("~/")) return trimmed;

    // Relative: require a known cwd; then join into an absolute path.
    if (!this.cwd) {
      this.postStatus("상대경로는 사용할 수 없습니다. 먼저 절대경로를 입력하고 Refresh 하세요.");
      return;
    }
    return posixNormalize(path.posix.join(this.cwd, trimmed));
  }

  private formatAuthHint(message: string): string {
    const base = message.trim() || "SSH failed";
    if (/host key verification failed|known_hosts|are you sure you want to continue connecting/i.test(base)) {
      const target = this.system?.target ?? "";
      return `${base}\n\n처음 접속이면 터미널에서 한 번 \`ssh ${target}\` 실행 후 호스트키를 등록하세요.`;
    }
    if (/permission denied|authentication|batchmode/i.test(base)) {
      return `${base}\n\n(Non-interactive) SSH 인증이 필요합니다. 키/ssh-agent 설정 후 다시 시도하세요.`;
    }
    return base;
  }

  private async refresh(timeoutMs: number, requestedPath: string): Promise<void> {
    const raw = String(requestedPath ?? "");
    const target = raw.trim() ? this.resolveTargetPath(raw) : this.cwd ?? "~";
    if (!target) return;
    await this.listAtPath(target, timeoutMs);
  }

  private buildCdTo(targetPath: string): string {
    const p = String(targetPath ?? "").trim();
    if (!p) return "cd ~";
    if (p === "~") return "cd ~";
    if (p.startsWith("~/")) return `cd ~ && cd -- ${this.shQuote(p.slice(2))}`;
    if (p.startsWith("/")) return `cd -- ${this.shQuote(p)}`;
    // Fallback (shouldn't happen if resolveTargetPath is used)
    return `cd -- ${this.shQuote(p)}`;
  }

  private async listAtPath(targetPath: string, timeoutMs: number): Promise<void> {
    const seq = ++this.refreshSeq;
    try {
      if (seq !== this.refreshSeq) return;
      const system = this.system;
      if (!system) throw new Error("SSH is not initialized.");
      this.postStatus(`Listing...`);
      const listScript =
        `for f in .* *; do ` +
        `[ \"$f\" = \".\" ] && continue; ` +
        `[ \"$f\" = \"..\" ] && continue; ` +
        `[ -e \"$f\" ] || continue; ` +
        `owner=\"\"; group=\"\"; permn=\"\"; permt=\"\"; ` +
        `if meta=$(stat -c '%U|%G|%a|%A' -- \"$f\" 2>/dev/null); then ` +
        `IFS='|' read -r owner group permn permt <<EOF\n$meta\nEOF\n` +
        `elif meta=$(stat -f '%Su|%Sg|%Lp|%Sp' -- \"$f\" 2>/dev/null); then ` +
        `IFS='|' read -r owner group permn permt <<EOF\n$meta\nEOF\n` +
        `fi; ` +
        `name64=$f; ` +
        `if command -v base64 >/dev/null 2>&1; then ` +
        `name64=$(printf '%s' \"$f\" | base64 | tr -d '\\n'); ` +
        `fi; ` +
        `if [ -d \"$f\" ]; then ` +
        `printf 'D|0|%s|%s|%s|%s|%s\\n' \"$permn\" \"$permt\" \"$owner\" \"$group\" \"$name64\"; ` +
        `else ` +
        `sz=$( (wc -c < \"$f\") 2>/dev/null | tr -d ' ' ); ` +
        `[ -n \"$sz\" ] || sz=0; ` +
        `printf 'F|%s|%s|%s|%s|%s|%s\\n' \"$sz\" \"$permn\" \"$permt\" \"$owner\" \"$group\" \"$name64\"; ` +
        `fi; ` +
        `done`;
      const cdTo = this.buildCdTo(targetPath);
      const res = await system.execSh(
        `${cdTo} && pwd && (${listScript})`,
        timeoutMs
      );
      if (seq !== this.refreshSeq) return;
      if (res.code !== 0) throw new Error((res.stderr || res.stdout || "SSH failed").trim());
      const allLines = (res.stdout ?? "")
        .split("\n")
        .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
        .filter((l) => l.length > 0);
      const pwdLine = allLines[0] ?? "";
      const lines = allLines.slice(1);
      if (pwdLine) this.cwd = posixNormalize(pwdLine.replaceAll(/\u001b\[[0-9;]*m/g, ""));
      const entries: DirEntry[] = lines
        .map((l) => l.replaceAll(/\u001b\[[0-9;]*m/g, ""))
        .map((l) => {
          const parts = l.split("|");
          if (parts.length < 7) return undefined;
          const kind = parts[0];
          const sizeText = parts[1];
          const permNum = parts[2] ?? "";
          const permText = parts[3] ?? "";
          const owner = parts[4] ?? "";
          const group = parts[5] ?? "";
          const name64 = parts.slice(6).join("|");
          const name = (() => {
            try {
              return Buffer.from(String(name64), "base64").toString("utf8");
            } catch {
              return String(name64);
            }
          })();
          if (!name || name === "." || name === "..") return undefined;
          if (kind !== "D" && kind !== "F") return undefined;
          const size = Number(sizeText);
          return {
            name,
            isDir: kind === "D",
            size: Number.isFinite(size) ? size : 0,
            owner: String(owner),
            group: String(group),
            permNum: String(permNum),
            permText: String(permText)
          };
        })
        .filter(Boolean) as DirEntry[];
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      if (seq !== this.refreshSeq) return;
      this.postDir(entries);
      this.postStatus(this.cwd ?? "");
    } catch (e: any) {
      if (seq !== this.refreshSeq) return;
      this.postStatus(this.formatAuthHint(String(e?.message ?? e ?? "Failed to list directory")));
      this.postDir([]);
    }
  }

  private async downloadFile(name: string, timeoutMs: number): Promise<void> {
    if (!this.cwd) {
      this.postStatus("No current folder. Click Refresh first.");
      return;
    }
    const remotePath = posixNormalize(path.posix.join(this.cwd!, name));

    const localUri = await vscode.window.showSaveDialog({
      title: "Save remote file",
      defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", name)),
      saveLabel: "Download"
    });
    if (!localUri) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${name}`, cancellable: false },
      async () => {
        this.postStatus(`Downloading: ${remotePath}`);
        await this.system!.scpDownload(remotePath, localUri.fsPath, timeoutMs * 4);
        this.postStatus(`Downloaded: ${localUri.fsPath}`);
      }
    );
  }

  private async viewFile(name: string, timeoutMs: number): Promise<void> {
    if (!this.cwd) {
      this.postStatus("No current folder. Click Refresh first.");
      return;
    }
    const system = this.system;
    if (!system) throw new Error("SSH is not initialized.");

    const remotePath = posixNormalize(path.posix.join(this.cwd, name));
    const maxBytes = 1024 * 1024; // 1MB
    const cmd =
      `sz=$( (wc -c < ${this.shQuote(remotePath)}) 2>/dev/null | tr -d ' ' ); ` +
      `[ -n \"$sz\" ] || sz=0; ` +
      `if [ \"$sz\" -gt ${maxBytes} ]; then echo \"__MORE_CONNECT_TOO_LARGE__:$sz\"; exit 0; fi; ` +
      `cat -- ${this.shQuote(remotePath)}`;
    const res = await system.execSh(cmd, timeoutMs);
    if (res.code !== 0) throw new Error((res.stderr || res.stdout || "View failed").trim());
    const out = String(res.stdout ?? "");
    if (out.startsWith("__MORE_CONNECT_TOO_LARGE__:")) {
      const bytes = out.split(":")[1]?.trim() || "";
      this.postStatus(`Too large to view (${bytes} bytes). Use Download.`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument({ content: out });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async deleteEntry(name: string, isDir: boolean, timeoutMs: number): Promise<void> {
    if (!this.cwd) {
      this.postStatus("No current folder. Click Refresh first.");
      return;
    }
    const system = this.system;
    if (!system) throw new Error("SSH is not initialized.");

    const remotePath = posixNormalize(path.posix.join(this.cwd, name));
    if (!remotePath || remotePath === "/") {
      this.postStatus("Refusing to delete this path.");
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Delete ${isDir ? "folder" : "file"}?\n${remotePath}`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting ${name}`,
        cancellable: false
      },
      async () => {
        const cmd = isDir ? `rm -rf -- ${this.shQuote(remotePath)}` : `rm -f -- ${this.shQuote(remotePath)}`;
        const res = await system.execSh(cmd, timeoutMs);
        if (res.code !== 0) throw new Error((res.stderr || res.stdout || "Delete failed").trim());
      }
    );

    await this.listAtPath(this.cwd, timeoutMs);
  }
}
