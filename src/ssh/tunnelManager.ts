import * as net from "node:net";
import * as fs from "node:fs";
import type { OptionalModuleLoader } from "../db/factory";
import type { ConnectionConfig } from "../types";

type SshClient = {
  on(event: "error", cb: (e: Error) => void): void;
  on(event: "ready", cb: () => void): void;
  connect(options: any): void;
  end(): void;
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    cb: (err: Error | undefined, stream: any) => void
  ): void;
};

type TunnelHandle = {
  localHost: string;
  localPort: number;
  close(): Promise<void>;
};

export class TunnelManager {
  private readonly byConnectionId = new Map<string, TunnelHandle>();

  public constructor(private readonly loader: OptionalModuleLoader) {}

  public async ensureTunnel(
    config: ConnectionConfig,
    sshPassword: string | undefined
  ): Promise<{ host: string; port: number } | undefined> {
    if (!config.sshEnabled) return;
    const existing = this.byConnectionId.get(config.id);
    if (existing) return { host: existing.localHost, port: existing.localPort };

    const sshHost = config.sshHost?.trim();
    const sshUser = config.sshUser?.trim();
    if (!sshHost || !sshUser) throw new Error("SSH host/user is required.");
    const sshPort = config.sshPort ?? 22;

    const remoteHost = (config.sshRemoteHost?.trim() || config.host).trim();
    const remotePort = config.sshRemotePort ?? config.port;
    if (!remoteHost || !remotePort) throw new Error("SSH remote host/port is required.");

    let ssh2: any;
    try {
      ssh2 = this.loader.require("ssh2");
    } catch {
      throw new Error("Missing driver: ssh2");
    }

    const sshClient: SshClient = new ssh2.Client();
    await new Promise<void>((resolve, reject) => {
      sshClient.on("ready", () => resolve());
      sshClient.on("error", (e) => reject(e));
      const privateKeyPath = config.sshPrivateKeyPath?.trim();
      const privateKey = privateKeyPath ? fs.readFileSync(privateKeyPath, "utf8") : undefined;
      sshClient.connect({
        host: sshHost,
        port: sshPort,
        username: sshUser,
        password: sshPassword || undefined,
        privateKey
      });
    });

    const server = net.createServer((localSocket) => {
      sshClient.forwardOut(
        localSocket.localAddress ?? "127.0.0.1",
        localSocket.localPort ?? 0,
        remoteHost,
        remotePort,
        (err, stream) => {
          if (err) {
            localSocket.destroy(err);
            return;
          }
          localSocket.pipe(stream);
          stream.pipe(localSocket);
        }
      );
    });

    const localHost = "127.0.0.1";
    const localPort = await new Promise<number>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, localHost, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") return reject(new Error("Failed to bind local tunnel port"));
        resolve(addr.port);
      });
    });

    const handle: TunnelHandle = {
      localHost,
      localPort,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          sshClient.end();
        } catch {}
      }
    };
    this.byConnectionId.set(config.id, handle);
    return { host: localHost, port: localPort };
  }

  public async closeTunnel(connectionId: string): Promise<void> {
    const handle = this.byConnectionId.get(connectionId);
    if (!handle) return;
    this.byConnectionId.delete(connectionId);
    await handle.close();
  }
}

