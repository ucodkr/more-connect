import type * as vscode from "vscode";
import type { ExplorerGroupName } from "../ui/explorerView";

export type SavedSql = {
  id: string;
  name: string;
  sql: string;
  connectionId?: string;
  database?: string;
  favorite?: boolean;
  updatedAt: number;
};

export type SqlFileContext = {
  connectionId?: string;
  database?: string;
  updatedAt: number;
};

type ExtensionStateDeps = {
  globalState: vscode.Memento;
  activeConnectionKey: string;
  savedSqlKey: string;
  sqlFileContextKey: string;
  explorerGroupStateKey: string;
  onActiveConnectionChanged?: () => void;
  onSqlContextChanged?: () => void;
};

export function createExtensionState(deps: ExtensionStateDeps) {
  const activeDbByConnectionId = new Map<string, string>();

  function getActiveConnectionId(): string | undefined {
    return deps.globalState.get<string>(deps.activeConnectionKey);
  }

  async function setActiveConnectionId(id: string | undefined): Promise<void> {
    await deps.globalState.update(deps.activeConnectionKey, id);
    deps.onActiveConnectionChanged?.();
  }

  function setActiveDatabaseForConnection(connectionId: string, database: string): void {
    if (!database) return;
    activeDbByConnectionId.set(connectionId, database);
    deps.onSqlContextChanged?.();
  }

  function getActiveDatabaseForConnection(connectionId: string | undefined): string | undefined {
    if (!connectionId) return;
    return activeDbByConnectionId.get(connectionId);
  }

  function getExplorerGroupState(): Record<ExplorerGroupName, boolean> {
    const saved = deps.globalState.get<Partial<Record<ExplorerGroupName, boolean>>>(deps.explorerGroupStateKey, {});
    return {
      db: saved.db ?? true,
      ssh: saved.ssh ?? true,
      web: saved.web ?? true,
      rest: saved.rest ?? true,
      s3: saved.s3 ?? true,
      docker: saved.docker ?? true,
      vscode: saved.vscode ?? true,
      ollama: saved.ollama ?? true
    };
  }

  async function setExplorerGroupExpanded(group: ExplorerGroupName, expanded: boolean): Promise<void> {
    const next = getExplorerGroupState();
    next[group] = expanded;
    await deps.globalState.update(deps.explorerGroupStateKey, next);
  }

  function getSqlFileContext(uri: vscode.Uri): SqlFileContext | undefined {
    const all = deps.globalState.get<Record<string, SqlFileContext>>(deps.sqlFileContextKey, {});
    return all[uri.toString()];
  }

  async function setSqlFileContext(uri: vscode.Uri, next: Omit<SqlFileContext, "updatedAt">): Promise<void> {
    const all = deps.globalState.get<Record<string, SqlFileContext>>(deps.sqlFileContextKey, {});
    all[uri.toString()] = { ...next, updatedAt: Date.now() };
    await deps.globalState.update(deps.sqlFileContextKey, all);
    if (next.connectionId && next.database) {
      setActiveDatabaseForConnection(next.connectionId, next.database);
    }
    deps.onSqlContextChanged?.();
  }

  function listSavedSql(): SavedSql[] {
    return deps.globalState.get<SavedSql[]>(deps.savedSqlKey, []);
  }

  async function upsertSavedSql(entry: Omit<SavedSql, "updatedAt"> & { updatedAt?: number }): Promise<void> {
    const all = listSavedSql();
    const updatedAt = entry.updatedAt ?? Date.now();
    const existingIndex = all.findIndex((item) => item.id === entry.id);
    const next: SavedSql = { ...entry, updatedAt };
    if (existingIndex >= 0) {
      all.splice(existingIndex, 1, next);
    } else {
      all.unshift(next);
    }
    await deps.globalState.update(deps.savedSqlKey, all.slice(0, 200));
  }

  return {
    getActiveConnectionId,
    setActiveConnectionId,
    setActiveDatabaseForConnection,
    getActiveDatabaseForConnection,
    getExplorerGroupState,
    setExplorerGroupExpanded,
    getSqlFileContext,
    setSqlFileContext,
    listSavedSql,
    upsertSavedSql
  };
}
