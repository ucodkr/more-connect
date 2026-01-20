import type { ConnectionConfig } from "./types";
import * as vscode from "vscode";

const KEY = "moreConnect.connections";

export class ConnectionStore {
  public constructor(private readonly memento: vscode.Memento) {}

  public list(): ConnectionConfig[] {
    return this.memento.get<ConnectionConfig[]>(KEY, []);
  }

  public async saveAll(connections: ConnectionConfig[]): Promise<void> {
    await this.memento.update(KEY, connections);
  }
}

