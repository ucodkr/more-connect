import type { ConnectionConfig, QueryResult } from "../types";
import type { DbClient } from "./client";
import * as net from "node:net";
import * as tls from "node:tls";

type RedisValue = string | number | null | RedisValue[] | { [k: string]: RedisValue };

export class RedisClient implements DbClient {
  public readonly config: ConnectionConfig;
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }> = [];

  public constructor(config: ConnectionConfig) {
    this.config = config;
  }

  public get isConnected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  public async connect(password: string): Promise<void> {
    if (this.isConnected) return;
    const host = this.config.host || "127.0.0.1";
    const port = this.config.port || 6379;
    const useTls = Boolean(this.config.ssl);

    const socket: any = useTls
      ? tls.connect({ host, port, rejectUnauthorized: false })
      : net.connect({ host, port });

    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = [];

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err: Error) => this.onError(err));
    socket.on("close", () => this.onError(new Error("Redis connection closed")));

    await onceConnected(socket);

    if (password) {
      await this.sendCommand(["AUTH", password]);
    }
    const db = this.config.database ? Number(this.config.database) : this.config.redisDatabase ?? 0;
    if (typeof db === "number" && Number.isFinite(db) && db !== 0) {
      await this.sendCommand(["SELECT", String(db)]);
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.socket) return;
    const s = this.socket;
    this.socket = null;
    try {
      s.end();
    } finally {
      s.destroy();
    }
  }

  public async query(sql: string): Promise<QueryResult> {
    if (!this.isConnected) throw new Error("Not connected");
    const start = Date.now();
    const first = firstNonEmptyCommand(sql);
    const args = splitArgs(first);
    if (args.length === 0) throw new Error("Empty command");
    const value = await this.sendCommand(args);
    const durationMs = Date.now() - start;
    return {
      columns: ["value"],
      rows: [{ value: stringifyRedis(value) }],
      rowCount: 1,
      durationMs
    };
  }

  public async listDatabases(): Promise<string[]> {
    return Array.from({ length: 16 }, (_, i) => String(i));
  }

  public async listTables(database: string): Promise<Array<{ name: string; schema?: string; type?: string }>> {
    if (!this.isConnected) throw new Error("Not connected");
    const db = Number(database);
    if (Number.isFinite(db)) {
      await this.sendCommand(["SELECT", String(db)]);
    }
    const resp = (await this.sendCommand(["SCAN", "0", "COUNT", "200"])) as any;
    const keys = Array.isArray(resp?.[1]) ? resp[1] : [];
    return keys.map((k: any) => ({ name: String(k), type: "key" }));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const parsed = parseResp(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.consumed);
      const waiter = this.pending.shift();
      if (!waiter) continue;
      if (parsed.error) waiter.reject(parsed.error);
      else waiter.resolve(parsed.value);
    }
  }

  private onError(err: Error): void {
    while (this.pending.length) {
      this.pending.shift()!.reject(err);
    }
  }

  public async sendCommand<T = RedisValue>(args: string[]): Promise<T> {
    if (!this.socket) throw new Error("Not connected");
    const payload = encodeRespArray(args);
    return await new Promise<T>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket!.write(payload);
    });
  }
}

function onceConnected(socket: net.Socket | tls.TLSSocket): Promise<void> {
  if ((socket as any).readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("connect", onConnect);
      (socket as any).off?.("secureConnect", onConnect);
    };
    socket.on("error", onError);
    socket.on("connect", onConnect);
    (socket as any).on?.("secureConnect", onConnect);
  });
}

function encodeRespArray(args: string[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from(`*${args.length}\r\n`));
  for (const a of args) {
    const b = Buffer.from(a, "utf8");
    parts.push(Buffer.from(`$${b.length}\r\n`));
    parts.push(b);
    parts.push(Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

function parseResp(buffer: Buffer): { consumed: number; value?: any; error?: Error } | null {
  if (buffer.length < 1) return null;
  const prefix = String.fromCharCode(buffer[0]);
  if (prefix === "+") {
    const line = readLine(buffer, 1);
    if (!line) return null;
    return { consumed: line.next, value: line.text };
  }
  if (prefix === "-") {
    const line = readLine(buffer, 1);
    if (!line) return null;
    return { consumed: line.next, error: new Error(line.text) };
  }
  if (prefix === ":") {
    const line = readLine(buffer, 1);
    if (!line) return null;
    return { consumed: line.next, value: Number(line.text) };
  }
  if (prefix === "$") {
    const line = readLine(buffer, 1);
    if (!line) return null;
    const len = Number(line.text);
    if (len === -1) return { consumed: line.next, value: null };
    const start = line.next;
    const end = start + len;
    if (buffer.length < end + 2) return null;
    const text = buffer.subarray(start, end).toString("utf8");
    return { consumed: end + 2, value: text };
  }
  if (prefix === "*") {
    const line = readLine(buffer, 1);
    if (!line) return null;
    const count = Number(line.text);
    if (count === -1) return { consumed: line.next, value: null };
    let offset = line.next;
    const items: any[] = [];
    for (let i = 0; i < count; i++) {
      const sub = parseResp(buffer.subarray(offset));
      if (!sub) return null;
      if (sub.error) return { consumed: offset + sub.consumed, error: sub.error };
      items.push(sub.value);
      offset += sub.consumed;
    }
    return { consumed: offset, value: items };
  }
  return { consumed: buffer.length, error: new Error("Unknown RESP prefix") };
}

function readLine(buffer: Buffer, start: number): { text: string; next: number } | null {
  const idx = buffer.indexOf("\r\n", start);
  if (idx === -1) return null;
  const text = buffer.subarray(start, idx).toString("utf8");
  return { text, next: idx + 2 };
}

function firstNonEmptyCommand(input: string): string {
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("--") || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return "";
}

function splitArgs(command: string): string[] {
  const args: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const part = m[1] ?? m[2] ?? m[3] ?? "";
    args.push(unescapeQuoted(part));
  }
  return args;
}

function unescapeQuoted(s: string): string {
  return s.replaceAll("\\n", "\n").replaceAll("\\t", "\t").replaceAll("\\\"", "\"").replaceAll("\\'", "'");
}

function stringifyRedis(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
