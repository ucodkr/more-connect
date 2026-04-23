import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { readState as readWebviewState } from "./shared";

type DbType = "mysql" | "mariadb" | "postgres" | "sqlite" | "oracle" | "redis";

type WizardMessage = { type: "cancel" } | { type: "save"; payload: WizardFormState } | { type: "test"; payload: WizardFormState };

type WizardInitState = {
  name: string;
  type: DbType;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: boolean;
  sqliteFilePath: string;
  oracleConnectString: string;
  oraclePrivilege: "default" | "sysdba" | "sysoper";
  redisDatabase: number | string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshPrivateKeyPath: string;
  sshRemoteHost: string;
  sshRemotePort: string;
  isEdit: boolean;
};

type WizardFormState = WizardInitState & {
  password: string;
  sshPassword: string;
  resetPassword: boolean;
};

const DB_TYPES: DbType[] = ["mysql", "mariadb", "postgres", "sqlite", "oracle", "redis"];
const ORACLE_PRIVILEGES: Array<WizardInitState["oraclePrivilege"]> = ["default", "sysdba", "sysoper"];

const defaultsByType: Record<string, Partial<WizardFormState>> = {
  mysql: { host: "localhost", port: 3306, user: "root" },
  mariadb: { host: "localhost", port: 3306, user: "root" },
  postgres: { host: "localhost", port: 5432, user: "postgres", database: "postgres" },
  redis: { host: "127.0.0.1", port: 6379, user: "", database: "", redisDatabase: "0" },
  oracle: { host: "host:1521/service_name", port: 1521, user: "SYSTEM", oracleConnectString: "host:1521/service_name" },
  sqlite: { sqliteFilePath: "/path/to/app.db" }
};

const styles = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe WPC, Segoe UI, sans-serif; }
  .page { padding: 14px; min-height: 100%; }
  .grid { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 10px 12px; align-items: center; max-width: 820px; }
  .label { opacity: 0.9; }
  .input, .select { width: 100%; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, rgba(127,127,127,.35)); border-radius: 6px; }
  .row { display: contents; }
  .checkbox { display: flex; align-items: center; gap: 8px; min-height: 32px; }
  .checkbox input { width: auto; }
  .hint { grid-column: 1 / -1; opacity: 0.75; font-size: 12px; }
  .divider { grid-column: 1 / -1; height: 1px; background: rgba(127,127,127,0.25); margin: 8px 0; }
  .inline { display: flex; gap: 10px; align-items: center; }
  .grow { flex: 1; }
  .actions { margin-top: 16px; display: flex; gap: 10px; }
  .button { padding: 7px 12px; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
  .button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .button.secondary { background: transparent; color: inherit; border-color: rgba(127,127,127,.35); }
  .error { margin-top: 10px; color: var(--vscode-errorForeground, #d11); min-height: 18px; }
  @media (max-width: 720px) {
    .grid { grid-template-columns: 1fr; }
    .label { margin-bottom: -4px; }
    .actions { flex-wrap: wrap; }
  }
`;

function readState(): WizardInitState {
  return readWebviewState<WizardInitState>();
}

function toInitialFormState(init: WizardInitState): WizardFormState {
  return {
    ...init,
    redisDatabase: String(init.redisDatabase ?? "0"),
    password: "",
    sshPassword: "",
    resetPassword: false
  };
}

function App(): React.JSX.Element {
  const vscode = useMemo(() => acquireVsCodeApi(), []);
  const [form, setForm] = useState<WizardFormState>(() => toInitialFormState(readState()));
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showSshPassword, setShowSshPassword] = useState(false);
  const lastTypeRef = useRef<DbType>(form.type);

  useEffect(() => {
    const onMessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
      if (event.data?.type === "error") {
        setError(event.data.message || "Error");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const setField = <K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const applyDefaults = (nextType: DbType, prevType: DbType) => {
    const prevDefaults = defaultsByType[prevType] ?? {};
    const nextDefaults = defaultsByType[nextType] ?? {};

    setForm((prev) => {
      const next = { ...prev, type: nextType };
      const maybeSet = (key: keyof WizardFormState, value: unknown, prevValue: unknown) => {
        const current = String(next[key] ?? "");
        if (!current.trim() || (prevValue !== undefined && current === String(prevValue))) {
          next[key] = String(value ?? "") as WizardFormState[keyof WizardFormState];
        }
      };

      if (nextType === "sqlite") {
        maybeSet("sqliteFilePath", nextDefaults.sqliteFilePath, prevDefaults.sqliteFilePath);
        return next;
      }

      if (nextType === "oracle") {
        maybeSet("oracleConnectString", nextDefaults.oracleConnectString ?? nextDefaults.host, prevDefaults.oracleConnectString ?? prevDefaults.host);
        maybeSet("user", nextDefaults.user ?? "", prevDefaults.user);
        next.host = String(next.oracleConnectString || next.host);
        next.port = String(nextDefaults.port ?? 1521) as unknown as number;
        return next;
      }

      maybeSet("host", nextDefaults.host ?? "", prevDefaults.host);
      maybeSet("port", String(nextDefaults.port ?? ""), String(prevDefaults.port ?? ""));
      maybeSet("user", nextDefaults.user ?? "", prevDefaults.user);
      maybeSet("database", nextDefaults.database ?? "", prevDefaults.database);
      if (nextType === "redis") {
        maybeSet("redisDatabase", nextDefaults.redisDatabase ?? "0", prevDefaults.redisDatabase);
        next.user = "";
        next.database = "";
      }
      return next;
    });
  };

  const onTypeChange = (nextType: DbType) => {
    applyDefaults(nextType, lastTypeRef.current);
    lastTypeRef.current = nextType;
  };

  const isSqlite = form.type === "sqlite";
  const isOracle = form.type === "oracle";
  const isRedis = form.type === "redis";

  const collect = (): WizardFormState => ({
    ...form,
    host: form.host,
    port: Number(form.port),
    database: form.database,
    redisDatabase: String(form.redisDatabase ?? ""),
    oracleConnectString: form.oracleConnectString || form.host
  });

  const post = (type: WizardMessage["type"]) => {
    setError("");
    if (type === "cancel") {
      vscode.postMessage({ type });
      return;
    }
    const payload = collect();
    vscode.postMessage({ type, payload });
  };

  return (
    <>
      <style>{styles}</style>
      <div className="page">
        <div className="grid">
          <div className="row">
            <label className="label" htmlFor="name">Name</label>
            <input id="name" className="input" value={form.name} onChange={(e) => setField("name", e.target.value)} />
          </div>

          <div className="row">
            <label className="label" htmlFor="type">Type</label>
            <select
              id="type"
              className="select"
              value={form.type}
              onChange={(e) => onTypeChange(e.target.value as DbType)}
            >
              {DB_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>

          {!isSqlite && !isOracle ? (
            <>
              <div className="row">
                <label className="label" htmlFor="host">Host</label>
                <input id="host" className="input" value={form.host} onChange={(e) => setField("host", e.target.value)} />
              </div>
              <div className="row">
                <label className="label" htmlFor="port">Port</label>
                <input id="port" className="input" value={String(form.port)} onChange={(e) => setField("port", e.target.value as unknown as number)} />
              </div>
            </>
          ) : null}

          {!isSqlite && !isRedis ? (
            <>
              <div className="row">
                <label className="label" htmlFor="user">User</label>
                <input id="user" className="input" value={form.user} onChange={(e) => setField("user", e.target.value)} />
              </div>
              <div className="row">
                <label className="label" htmlFor="database">Database (optional)</label>
                <input id="database" className="input" value={form.database} onChange={(e) => setField("database", e.target.value)} />
              </div>
            </>
          ) : null}

          {!isSqlite && !isOracle ? (
            <div className="row">
              <div className="label">SSL</div>
              <label className="checkbox">
                <input type="checkbox" checked={form.ssl} onChange={(e) => setField("ssl", e.target.checked)} />
                <span>Enable</span>
              </label>
            </div>
          ) : null}

          {isSqlite ? (
            <>
              <div className="row">
                <label className="label" htmlFor="sqliteFilePath">SQLite file path</label>
                <input id="sqliteFilePath" className="input" value={form.sqliteFilePath} onChange={(e) => setField("sqliteFilePath", e.target.value)} />
              </div>
              <div className="hint">Example: /path/to/app.db</div>
            </>
          ) : null}

          {isOracle ? (
            <>
              <div className="row">
                <label className="label" htmlFor="oracleConnectString">Connect string</label>
                <input
                  id="oracleConnectString"
                  className="input"
                  value={form.oracleConnectString}
                  onChange={(e) => {
                    setField("oracleConnectString", e.target.value);
                    setField("host", e.target.value);
                  }}
                />
              </div>
              <div className="row">
                <label className="label" htmlFor="oraclePrivilege">Privilege</label>
                <select
                  id="oraclePrivilege"
                  className="select"
                  value={form.oraclePrivilege}
                  onChange={(e) => setField("oraclePrivilege", e.target.value as WizardInitState["oraclePrivilege"])}
                >
                  {ORACLE_PRIVILEGES.map((privilege) => (
                    <option key={privilege} value={privilege}>{privilege}</option>
                  ))}
                </select>
              </div>
              <div className="hint">Example: host:1521/service_name (EZConnect)</div>
            </>
          ) : null}

          {isRedis ? (
            <div className="row">
              <label className="label" htmlFor="redisDatabase">DB index (0-15)</label>
              <input
                id="redisDatabase"
                className="input"
                value={String(form.redisDatabase)}
                onChange={(e) => setField("redisDatabase", e.target.value)}
              />
            </div>
          ) : null}

          {!isSqlite ? (
            <>
              <div className="row">
                <label className="label" htmlFor="password">Password</label>
                <div className="inline">
                  <input
                    id="password"
                    className="input grow"
                    type={showPassword ? "text" : "password"}
                    value={form.password}
                    onChange={(e) => setField("password", e.target.value)}
                  />
                  <label className="checkbox">
                    <input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />
                    <span>Show</span>
                  </label>
                </div>
              </div>
              <div className="row">
                <div className="label">Reset saved password</div>
                <label className="checkbox">
                  <input type="checkbox" checked={form.resetPassword} onChange={(e) => setField("resetPassword", e.target.checked)} />
                  <span>{form.isEdit ? "Reset" : "—"}</span>
                </label>
              </div>
              <div className="hint">Leave password empty to keep existing saved password (edit).</div>
            </>
          ) : null}

          <div className="divider" />

          <div className="row">
            <div className="label">SSH Tunnel</div>
            <label className="checkbox">
              <input type="checkbox" checked={form.sshEnabled} onChange={(e) => setField("sshEnabled", e.target.checked)} />
              <span>Enable SSH over</span>
            </label>
          </div>

          {form.sshEnabled ? (
            <>
              <div className="row">
                <label className="label" htmlFor="sshHost">SSH Host</label>
                <input id="sshHost" className="input" value={form.sshHost} placeholder="bastion.example.com" onChange={(e) => setField("sshHost", e.target.value)} />
              </div>
              <div className="row">
                <label className="label" htmlFor="sshPort">SSH Port</label>
                <input id="sshPort" className="input" value={form.sshPort} onChange={(e) => setField("sshPort", e.target.value)} />
              </div>
              <div className="row">
                <label className="label" htmlFor="sshUser">SSH User</label>
                <input id="sshUser" className="input" value={form.sshUser} onChange={(e) => setField("sshUser", e.target.value)} />
              </div>
              <div className="row">
                <label className="label" htmlFor="sshPrivateKeyPath">SSH Private Key Path (optional)</label>
                <input id="sshPrivateKeyPath" className="input" value={form.sshPrivateKeyPath} placeholder="~/.ssh/id_rsa" onChange={(e) => setField("sshPrivateKeyPath", e.target.value)} />
              </div>
              <div className="row">
                <label className="label" htmlFor="sshPassword">SSH Password (optional)</label>
                <div className="inline">
                  <input
                    id="sshPassword"
                    className="input grow"
                    type={showSshPassword ? "text" : "password"}
                    value={form.sshPassword}
                    onChange={(e) => setField("sshPassword", e.target.value)}
                  />
                  <label className="checkbox">
                    <input type="checkbox" checked={showSshPassword} onChange={(e) => setShowSshPassword(e.target.checked)} />
                    <span>Show</span>
                  </label>
                </div>
              </div>
              <div className="row">
                <label className="label" htmlFor="sshRemoteHost">Remote Host (optional)</label>
                <input id="sshRemoteHost" className="input" value={form.sshRemoteHost} placeholder="db.internal" onChange={(e) => setField("sshRemoteHost", e.target.value)} />
              </div>
              <div className="row">
                <label className="label" htmlFor="sshRemotePort">Remote Port (optional)</label>
                <input id="sshRemotePort" className="input" value={form.sshRemotePort} placeholder="3306/5432/..." onChange={(e) => setField("sshRemotePort", e.target.value)} />
              </div>
              <div className="hint">If remote host/port are empty, it forwards to the connection&apos;s host/port.</div>
            </>
          ) : null}
        </div>

        <div className="actions">
          <button className="button primary" type="button" onClick={() => post("save")}>Save</button>
          <button className="button secondary" type="button" onClick={() => post("test")}>Test Connection</button>
          <button className="button secondary" type="button" onClick={() => post("cancel")}>Cancel</button>
        </div>
        <div className="error">{error}</div>
      </div>
    </>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing root element.");
}

createRoot(rootEl).render(<App />);
