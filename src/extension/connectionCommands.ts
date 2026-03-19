import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { ConnectionWizard } from "../ui/connectionWizard";
import type { ExplorerNode } from "../ui/explorerView";
import type { ConnectionStore } from "../storage";
import type { ConnectionConfig } from "../types";
import type { DbRuntime } from "./dbRuntime";

type RegisterConnectionCommandsDeps = {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  view: { refresh(node?: ExplorerNode): void };
  treeView: vscode.TreeView<ExplorerNode>;
  connectionWizard: ConnectionWizard;
  dbRuntime: DbRuntime;
  getActiveConnectionId(): string | undefined;
  setActiveConnectionId(id: string | undefined): Promise<void>;
  pickConnectedOrAnyConnection(): ConnectionConfig | undefined;
};

export function registerConnectionCommands(
  context: vscode.ExtensionContext,
  deps: RegisterConnectionCommandsDeps
): void {
  async function promptConnectionConfig(existing?: ConnectionConfig): Promise<{
    config: ConnectionConfig;
    password?: string;
    sshPassword?: string;
    resetPassword?: boolean;
  } | undefined> {
    const res = await deps.connectionWizard.open(existing);
    if (res.kind !== "save") return;
    return {
      config: res.config,
      password: res.password,
      sshPassword: res.sshPassword,
      resetPassword: res.resetPassword
    };
  }

  async function promptConnectionConfigFromPayload(payload: any): Promise<{
    config: ConnectionConfig;
    password?: string;
    sshPassword?: string;
  } | undefined> {
    const type = String(payload?.type ?? "");
    const name = String(payload?.name ?? "").trim() || `${type}-test`;
    const baseId = String(payload?.id ?? "") || randomUUID();
    const config: ConnectionConfig = {
      id: baseId,
      name,
      type: type as ConnectionConfig["type"],
      host: String(payload?.host ?? "").trim(),
      port: Number(payload?.port ?? 0),
      user: String(payload?.user ?? "").trim(),
      database: String(payload?.database ?? "").trim() || undefined,
      ssl: Boolean(payload?.ssl),
      sqliteFilePath: String(payload?.sqliteFilePath ?? "").trim() || undefined,
      oracleConnectString: String(payload?.oracleConnectString ?? "").trim() || undefined,
      oraclePrivilege:
        String(payload?.oraclePrivilege ?? "").trim() === "sysdba"
          ? "sysdba"
          : String(payload?.oraclePrivilege ?? "").trim() === "sysoper"
            ? "sysoper"
            : "default",
      redisDatabase:
        payload?.redisDatabase !== undefined && String(payload.redisDatabase).trim() !== ""
          ? Number(payload.redisDatabase)
          : undefined,
      sshEnabled: Boolean(payload?.sshEnabled),
      sshHost: String(payload?.sshHost ?? "").trim() || undefined,
      sshPort: payload?.sshPort !== undefined && String(payload.sshPort).trim() !== "" ? Number(payload.sshPort) : undefined,
      sshUser: String(payload?.sshUser ?? "").trim() || undefined,
      sshPrivateKeyPath: String(payload?.sshPrivateKeyPath ?? "").trim() || undefined,
      sshRemoteHost: String(payload?.sshRemoteHost ?? "").trim() || undefined,
      sshRemotePort:
        payload?.sshRemotePort !== undefined && String(payload.sshRemotePort).trim() !== ""
          ? Number(payload.sshRemotePort)
          : undefined
    };
    const password = String(payload?.password ?? "");
    const sshPassword = String(payload?.sshPassword ?? "");
    return { config, password: password || undefined, sshPassword: sshPassword || undefined };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.addConnection", async () => {
      const created = await promptConnectionConfig();
      if (!created) return;
      const { config, password, sshPassword } = created;
      await deps.store.saveAll([...deps.store.list(), config]);
      if (!deps.getActiveConnectionId()) await deps.setActiveConnectionId(config.id);
      if (password !== undefined && password.trim().length > 0) {
        await deps.context.secrets.store(`moreConnect.password.${config.id}`, password);
      }
      if (sshPassword !== undefined && sshPassword !== "") {
        await deps.context.secrets.store(`moreConnect.sshPassword.${config.id}`, sshPassword);
      }
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.testConnectionFromWizard", async (payload: any) => {
      try {
        const { config, password, sshPassword } = (await promptConnectionConfigFromPayload(payload)) ?? {};
        if (!config) return;
        await deps.dbRuntime.testConnection(config, password, sshPassword);
      } catch (e) {
        vscode.window.showErrorMessage(`Test failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.editConnection", async (node?: ExplorerNode) => {
      const config = node?.kind === "connection" ? node.config : deps.pickConnectedOrAnyConnection();
      if (!config) return;
      const edited = await promptConnectionConfig(config);
      if (!edited) return;
      const { config: updated, password, sshPassword, resetPassword } = edited;
      await deps.dbRuntime.disconnect(config);

      if (resetPassword) await deps.context.secrets.delete(`moreConnect.password.${updated.id}`);
      if (password !== undefined && password.trim().length > 0) {
        await deps.context.secrets.store(`moreConnect.password.${updated.id}`, password);
      }
      if (resetPassword) await deps.context.secrets.delete(`moreConnect.sshPassword.${updated.id}`);
      if (sshPassword !== undefined && sshPassword !== "") {
        await deps.context.secrets.store(`moreConnect.sshPassword.${updated.id}`, sshPassword);
      }

      await deps.store.saveAll(deps.store.list().map((c) => (c.id === updated.id ? updated : c)));
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.duplicateConnection", async (node?: ExplorerNode) => {
      const config = node?.kind === "connection" ? node.config : deps.pickConnectedOrAnyConnection();
      if (!config) return;

      const all = deps.store.list();
      const baseName = `${config.name} (copy)`;
      let nextName = baseName;
      for (let i = 2; all.some((c) => c.name === nextName); i++) {
        nextName = `${baseName} ${i}`;
      }

      const cloned: ConnectionConfig = { ...config, id: randomUUID(), name: nextName };
      await deps.store.saveAll([...all, cloned]);

      const existingPassword = await deps.context.secrets.get(`moreConnect.password.${config.id}`);
      if (existingPassword) await deps.context.secrets.store(`moreConnect.password.${cloned.id}`, existingPassword);
      const existingSshPassword = await deps.context.secrets.get(`moreConnect.sshPassword.${config.id}`);
      if (existingSshPassword) await deps.context.secrets.store(`moreConnect.sshPassword.${cloned.id}`, existingSshPassword);

      deps.view.refresh();
      vscode.window.showInformationMessage(`Connection duplicated: ${cloned.name}`);
    }),

    vscode.commands.registerCommand("moreConnect.removeConnection", async (node?: ExplorerNode) => {
      const config = node?.kind === "connection" ? node.config : undefined;
      if (!config) return;
      await deps.dbRuntime.disconnect(config);
      await deps.context.secrets.delete(`moreConnect.password.${config.id}`);
      await deps.context.secrets.delete(`moreConnect.sshPassword.${config.id}`);
      await deps.store.saveAll(deps.store.list().filter((c) => c.id !== config.id));
      deps.dbRuntime.clearConnectionClients(config.id);
      if (deps.getActiveConnectionId() === config.id) await deps.setActiveConnectionId(undefined);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.connect", async (node?: ExplorerNode) => {
      const config = node?.kind === "connection" ? node.config : deps.pickConnectedOrAnyConnection();
      if (!config) return;
      try {
        await deps.dbRuntime.connect(config);
        await deps.setActiveConnectionId(config.id);
        await deps.treeView.reveal(
          { kind: "connection", config, connected: true, active: true },
          { expand: true, focus: false, select: false }
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Connect failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.disconnect", async (node?: ExplorerNode) => {
      const config = node?.kind === "connection" ? node.config : deps.pickConnectedOrAnyConnection();
      if (!config) return;
      try {
        await deps.dbRuntime.disconnect(config);
      } catch (e) {
        vscode.window.showErrorMessage(`Disconnect failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.setActiveConnection", async (node?: ExplorerNode) => {
      const config = node?.kind === "connection" ? node.config : deps.pickConnectedOrAnyConnection();
      if (!config) return;
      await deps.setActiveConnectionId(config.id);
    }),

    vscode.commands.registerCommand("moreConnect.refreshSchema", async (node?: ExplorerNode) => {
      if (node?.kind === "connection" || node?.kind === "database") {
        deps.view.refresh(node);
        return;
      }
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.refreshDatabase", async (node?: ExplorerNode) => {
      if (node?.kind !== "database") return;
      deps.view.refresh(node);
    })
  );
}
