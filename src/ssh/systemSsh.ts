import * as cp from "node:child_process";
import type { SshConnection } from "../types";

export type SystemSsh = {
  target: string;
  execSh(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }>;
  scpDownload(remotePath: string, localFsPath: string, timeoutMs: number): Promise<void>;
};

function spawnWithOutput(
  bin: string,
  args: string[],
  opts: { timeoutMs: number }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = cp.spawn(bin, args, { shell: false });
    let stdout = "";
    let stderr = "";
    const timer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, opts.timeoutMs)
        : undefined;

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${String((e as any)?.message ?? e)}`, code: 127 });
    });
  });
}

function shQuoteSingle(s: string): string {
  // ' -> '"'"'
  return `'${s.replaceAll("'", `'\"'\"'`)}'`;
}

function connectTimeoutSeconds(timeoutMs: number): number {
  const s = Math.ceil(Math.max(1, timeoutMs) / 1000);
  return Math.min(Math.max(s, 1), 300);
}

export function createSystemSsh(conn: SshConnection): SystemSsh {
  const target = conn.target.trim();

  const sshCommon = (timeoutMs: number) => [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeoutSeconds(timeoutMs)}`
  ];

  const execSh = async (command: string, timeoutMs: number) => {
    // IMPORTANT:
    // OpenSSH runs the remote command through the remote user's shell as a single string.
    // So passing ["sh","-lc",command] loses the argument boundary and breaks when command has spaces.
    // Wrap the script so it becomes a single argument to `sh -lc`.
    const scriptArg = shQuoteSingle(command);
    return await spawnWithOutput(
      "ssh",
      [...sshCommon(timeoutMs), target, "sh", "-lc", scriptArg],
      { timeoutMs }
    );
  };

  const scpDownload = async (remotePath: string, localFsPath: string, timeoutMs: number): Promise<void> => {
    // NOTE: Do not add extra quotes around remotePath here.
    // We pass args without a shell; wrapping in quotes makes scp look for a path literally containing quotes.
    const src = `${target}:${remotePath}`;
    const res = await spawnWithOutput("scp", [...sshCommon(timeoutMs), src, localFsPath], { timeoutMs });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout || "scp failed").trim());
  };

  return { target, execSh, scpDownload };
}
