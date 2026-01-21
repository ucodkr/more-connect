import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ConnectionConfig, DbType } from "../types";

type WizardResult =
  | { kind: "cancel" }
  | { kind: "save"; config: ConnectionConfig; password?: string; sshPassword?: string; resetPassword?: boolean };
type WizardMessage = { type: "cancel" } | { type: "save"; payload: any } | { type: "test"; payload: any };

export class ConnectionWizard {
  private panel: vscode.WebviewPanel | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async open(existing?: ConnectionConfig): Promise<WizardResult> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "moreConnect.connectionWizard",
        existing ? "Edit Connection" : "Add Connection",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: false }
      );
      this.panel.onDidDispose(() => (this.panel = undefined), undefined, this.context.subscriptions);
    } else {
      this.panel.title = existing ? "Edit Connection" : "Add Connection";
      this.panel.reveal(vscode.ViewColumn.Active, true);
    }

    const panel = this.panel;
    panel.webview.html = renderHtml(existing);

    return await new Promise<WizardResult>((resolve) => {
      const sub = panel.webview.onDidReceiveMessage(
        async (msg: WizardMessage) => {
          if (msg?.type === "cancel") {
            sub.dispose();
            resolve({ kind: "cancel" });
            return;
          }
          if (msg?.type === "test") {
            await vscode.commands.executeCommand("moreConnect.testConnectionFromWizard", msg.payload);
            return;
          }
          if (msg?.type !== "save") return;

          try {
            const parsed = parseForm(existing, msg?.payload);
            sub.dispose();
            resolve(parsed);
          } catch (e) {
            panel.webview.postMessage({ type: "error", message: (e as Error).message });
          }
        },
        undefined,
        this.context.subscriptions
      );
    });
  }
}

function parseForm(existing: ConnectionConfig | undefined, payload: any): WizardResult {
  const type = String(payload?.type ?? "") as DbType;
  if (!type) throw new Error("Type is required.");
  const name = String(payload?.name ?? "").trim();
  if (!name) throw new Error("Name is required.");

  const id = existing?.id ?? randomUUID();
  const resetPassword = Boolean(payload?.resetPassword);
  const password = String(payload?.password ?? "");
  const sshEnabled = Boolean(payload?.sshEnabled);
  const sshPassword = String(payload?.sshPassword ?? "");
  const sshHost = String(payload?.sshHost ?? "").trim() || undefined;
  const sshPortRaw = String(payload?.sshPort ?? "").trim();
  const sshPort = sshPortRaw ? Number(sshPortRaw) : undefined;
  const sshUser = String(payload?.sshUser ?? "").trim() || undefined;
  const sshPrivateKeyPath = String(payload?.sshPrivateKeyPath ?? "").trim() || undefined;
  const sshRemoteHost = String(payload?.sshRemoteHost ?? "").trim() || undefined;
  const sshRemotePortRaw = String(payload?.sshRemotePort ?? "").trim();
  const sshRemotePort = sshRemotePortRaw ? Number(sshRemotePortRaw) : undefined;

  if (type === "sqlite") {
    const file = String(payload?.sqliteFilePath ?? "").trim();
    if (!file) throw new Error("SQLite file path is required.");
    const config: ConnectionConfig = {
      id,
      name,
      type,
      host: file,
      port: 0,
      user: "",
      sqliteFilePath: file,
      sshEnabled,
      sshHost,
      sshPort,
      sshUser,
      sshPrivateKeyPath,
      sshRemoteHost,
      sshRemotePort
    };
    return {
      kind: "save",
      config,
      sshPassword: sshPassword || undefined,
      resetPassword: resetPassword || undefined
    };
  }

  if (type === "redis") {
    const host = String(payload?.host ?? "").trim() || "127.0.0.1";
    const port = Number(payload?.port ?? 6379);
    if (!Number.isFinite(port)) throw new Error("Redis port must be a number.");
    const dbRaw = String(payload?.redisDatabase ?? "").trim();
    const redisDatabase = dbRaw.length ? Number(dbRaw) : undefined;
    if (redisDatabase !== undefined && !Number.isFinite(redisDatabase)) throw new Error("Redis DB must be a number.");
    const ssl = Boolean(payload?.ssl);
    const config: ConnectionConfig = {
      id,
      name,
      type,
      host,
      port,
      user: "",
      database: redisDatabase !== undefined ? String(redisDatabase) : undefined,
      redisDatabase,
      ssl,
      sshEnabled,
      sshHost,
      sshPort,
      sshUser,
      sshPrivateKeyPath,
      sshRemoteHost,
      sshRemotePort
    };
    return {
      kind: "save",
      config,
      password: password || undefined,
      sshPassword: sshPassword || undefined,
      resetPassword: resetPassword || undefined
    };
  }

  if (type === "oracle") {
    const connectString = String(payload?.oracleConnectString ?? payload?.host ?? "").trim();
    if (!connectString) throw new Error("Oracle connect string is required.");
    const user = String(payload?.user ?? "").trim();
    if (!user) throw new Error("User is required.");
    const database = String(payload?.database ?? "").trim() || undefined;
    const port = Number(payload?.port ?? 1521);
    const config: ConnectionConfig = {
      id,
      name,
      type,
      host: connectString,
      port: Number.isFinite(port) ? port : 1521,
      user,
      database,
      oracleConnectString: connectString,
      oraclePrivilege:
        String(payload?.oraclePrivilege ?? "").trim() === "sysdba"
          ? "sysdba"
          : String(payload?.oraclePrivilege ?? "").trim() === "sysoper"
            ? "sysoper"
            : "default",
      sshEnabled,
      sshHost,
      sshPort,
      sshUser,
      sshPrivateKeyPath,
      sshRemoteHost,
      sshRemotePort
    };
    return {
      kind: "save",
      config,
      password: password || undefined,
      sshPassword: sshPassword || undefined,
      resetPassword: resetPassword || undefined
    };
  }

  const host = String(payload?.host ?? "").trim();
  if (!host) throw new Error("Host is required.");
  const port = Number(payload?.port ?? (type === "postgres" ? 5432 : 3306));
  if (!Number.isFinite(port)) throw new Error("Port must be a number.");
  const user = String(payload?.user ?? "").trim();
  if (!user) throw new Error("User is required.");
  const database = String(payload?.database ?? "").trim() || undefined;
  const ssl = Boolean(payload?.ssl);

  const config: ConnectionConfig = {
    id,
    name,
    type,
    host,
    port,
    user,
    database,
    ssl,
    sshEnabled,
    sshHost,
    sshPort,
    sshUser,
    sshPrivateKeyPath,
    sshRemoteHost,
    sshRemotePort
  };
  return {
    kind: "save",
    config,
    password: password || undefined,
    sshPassword: sshPassword || undefined,
    resetPassword: resetPassword || undefined
  };
}

function renderHtml(existing?: ConnectionConfig): string {
  const init = {
    name: existing?.name ?? "",
    type: existing?.type ?? "mysql",
    host: existing?.host ?? "localhost",
    port: existing?.port ?? (existing?.type === "postgres" ? 5432 : existing?.type === "redis" ? 6379 : 3306),
    user: existing?.user ?? "",
    database: existing?.database ?? "",
    ssl: Boolean(existing?.ssl),
    sqliteFilePath: existing?.sqliteFilePath ?? "",
    oracleConnectString: existing?.oracleConnectString ?? (existing?.type === "oracle" ? existing.host : ""),
    oraclePrivilege: existing?.oraclePrivilege ?? "default",
    redisDatabase: existing?.redisDatabase ?? (existing?.type === "redis" ? existing.database ?? "0" : "0"),
    sshEnabled: Boolean(existing?.sshEnabled),
    sshHost: existing?.sshHost ?? "",
    sshPort: String(existing?.sshPort ?? 22),
    sshUser: existing?.sshUser ?? "",
    sshPrivateKeyPath: existing?.sshPrivateKeyPath ?? "",
    sshRemoteHost: existing?.sshRemoteHost ?? "",
    sshRemotePort: String(existing?.sshRemotePort ?? ""),
    isEdit: Boolean(existing)
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connection</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe WPC, Segoe UI, sans-serif; padding: 14px; }
    .grid { display: grid; grid-template-columns: 180px 1fr; gap: 10px 12px; align-items: center; max-width: 820px; }
    label { opacity: 0.9; }
    input, select { width: 100%; padding: 6px 8px; }
    .row { display: contents; }
    /* Keep rows aligned inside conditional groups */
    #group-network, #group-sqlite, #group-oracle, #group-redis, #group-password { display: contents; }
    .actions { margin-top: 16px; display: flex; gap: 10px; }
    button { padding: 7px 12px; }
    .hint { grid-column: 1 / -1; opacity: 0.75; font-size: 12px; }
    .hidden { display: none !important; }
    .error { margin-top: 10px; color: #d11; }
    .checkbox { display: flex; align-items: center; gap: 8px; }
    .checkbox input { width: auto; }
    .divider { grid-column: 1 / -1; height: 1px; background: rgba(127,127,127,0.25); margin: 8px 0; }
    .inline { display: flex; gap: 10px; align-items: center; }
    .inline .grow { flex: 1; }
  </style>
</head>
<body>
  <div class="grid">
    <div class="row" id="row-name">
      <label for="name">Name</label>
      <input id="name" value="${escapeHtml(init.name)}" />
    </div>

    <div class="row" id="row-type">
      <label for="type">Type</label>
      <select id="type">
        ${["mysql", "mariadb", "postgres", "sqlite", "oracle", "redis"]
          .map((t) => `<option value="${t}" ${t === init.type ? "selected" : ""}>${t}</option>`)
          .join("")}
      </select>
    </div>

    <div id="group-network">
      <div class="row" id="row-host">
        <label for="host">Host</label>
        <input id="host" value="${escapeHtml(init.host)}" />
      </div>
      <div class="row" id="row-port">
        <label for="port">Port</label>
        <input id="port" value="${String(init.port)}" />
      </div>
      <div class="row" id="row-user">
        <label for="user">User</label>
        <input id="user" value="${escapeHtml(init.user)}" />
      </div>
      <div class="row" id="row-database">
        <label for="database">Database (optional)</label>
        <input id="database" value="${escapeHtml(init.database)}" />
      </div>
      <div class="row" id="row-ssl">
        <label>SSL</label>
        <div class="checkbox"><input id="ssl" type="checkbox" ${init.ssl ? "checked" : ""} /><span>Enable</span></div>
      </div>
    </div>

    <div id="group-sqlite" class="hidden">
      <div class="row" id="row-sqliteFilePath">
        <label for="sqliteFilePath">SQLite file path</label>
        <input id="sqliteFilePath" value="${escapeHtml(init.sqliteFilePath)}" />
      </div>
      <div class="hint">Example: /path/to/app.db</div>
    </div>

    <div id="group-oracle" class="hidden">
      <div class="row" id="row-oracleConnectString">
        <label for="oracleConnectString">Connect string</label>
        <input id="oracleConnectString" value="${escapeHtml(init.oracleConnectString)}" />
      </div>
      <div class="row" id="row-oraclePrivilege">
        <label for="oraclePrivilege">Privilege</label>
        <select id="oraclePrivilege">
          ${["default", "sysdba", "sysoper"]
            .map((p) => `<option value="${p}" ${p === init.oraclePrivilege ? "selected" : ""}>${p}</option>`)
            .join("")}
        </select>
      </div>
      <div class="hint">Example: host:1521/service_name (EZConnect)</div>
    </div>

    <div id="group-redis" class="hidden">
      <div class="row" id="row-redisDatabase">
        <label for="redisDatabase">DB index (0-15)</label>
        <input id="redisDatabase" value="${escapeHtml(String(init.redisDatabase))}" />
      </div>
    </div>

    <div id="group-password">
      <div class="row">
        <label for="password">Password</label>
        <div class="inline">
          <input id="password" class="grow" type="password" value="" />
          <label class="checkbox"><input id="showPassword" type="checkbox" /><span>Show</span></label>
        </div>
      </div>
      <div class="row">
        <label>Reset saved password</label>
        <div class="checkbox"><input id="resetPassword" type="checkbox" /><span>${init.isEdit ? "Reset" : "—"}</span></div>
      </div>
      <div class="hint">Leave password empty to keep existing saved password (edit).</div>
    </div>

    <div class="divider"></div>

    <div class="row" id="row-sshEnabled">
      <label>SSH Tunnel</label>
      <div class="checkbox"><input id="sshEnabled" type="checkbox" ${init.sshEnabled ? "checked" : ""} /><span>Enable SSH over</span></div>
    </div>

    <div id="group-ssh" class="hidden">
      <div class="row" id="row-sshHost">
        <label for="sshHost">SSH Host</label>
        <input id="sshHost" value="${escapeHtml(init.sshHost)}" placeholder="bastion.example.com" />
      </div>
      <div class="row" id="row-sshPort">
        <label for="sshPort">SSH Port</label>
        <input id="sshPort" value="${escapeHtml(init.sshPort)}" />
      </div>
      <div class="row" id="row-sshUser">
        <label for="sshUser">SSH User</label>
        <input id="sshUser" value="${escapeHtml(init.sshUser)}" />
      </div>
      <div class="row" id="row-sshPrivateKeyPath">
        <label for="sshPrivateKeyPath">SSH Private Key Path (optional)</label>
        <input id="sshPrivateKeyPath" value="${escapeHtml(init.sshPrivateKeyPath)}" placeholder="~/.ssh/id_rsa" />
      </div>
      <div class="row" id="row-sshPassword">
        <label for="sshPassword">SSH Password (optional)</label>
        <div class="inline">
          <input id="sshPassword" class="grow" type="password" value="" />
          <label class="checkbox"><input id="showSshPassword" type="checkbox" /><span>Show</span></label>
        </div>
      </div>
      <div class="row" id="row-sshRemoteHost">
        <label for="sshRemoteHost">Remote Host (optional)</label>
        <input id="sshRemoteHost" value="${escapeHtml(init.sshRemoteHost)}" placeholder="db.internal" />
      </div>
      <div class="row" id="row-sshRemotePort">
        <label for="sshRemotePort">Remote Port (optional)</label>
        <input id="sshRemotePort" value="${escapeHtml(init.sshRemotePort)}" placeholder="3306/5432/..." />
      </div>
      <div class="hint">If remote host/port are empty, it forwards to the connection's host/port.</div>
    </div>
  </div>

  <div class="actions">
    <button id="save">Save</button>
    <button id="test">Test Connection</button>
    <button id="cancel">Cancel</button>
  </div>
  <div id="error" class="error"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const errorEl = $("error");
    let lastType = $("type").value;
    let lastSshEnabled = Boolean($("sshEnabled")?.checked);

    const defaultsByType = {
      mysql: { host: "localhost", port: "3306", user: "root" },
      mariadb: { host: "localhost", port: "3306", user: "root" },
      postgres: { host: "localhost", port: "5432", user: "postgres", database: "postgres" },
      redis: { host: "127.0.0.1", port: "6379", user: "", database: "", redisDatabase: "0" },
      oracle: { host: "host:1521/service_name", port: "1521", user: "SYSTEM" },
      sqlite: { sqliteFilePath: "/path/to/app.db" }
    };

    function applyDefaults(nextType, prevType) {
      const prev = defaultsByType[prevType] || {};
      const next = defaultsByType[nextType] || {};

      // Only overwrite if empty OR still matches the previous type's default.
      const maybeSet = (id, value, prevValue) => {
        const el = $(id);
        if (!el) return;
        const cur = String(el.value ?? "");
        if (!cur.trim() || (prevValue !== undefined && cur === String(prevValue))) {
          el.value = value ?? "";
        }
      };

      if (nextType === "sqlite") {
        maybeSet("sqliteFilePath", next.sqliteFilePath, prev.sqliteFilePath);
        return;
      }

      if (nextType === "oracle") {
        maybeSet("oracleConnectString", next.host, prev.host);
        maybeSet("user", next.user ?? "", prev.user);
        // database is optional; keep empty by default
        if ($("host")) $("host").value = $("oracleConnectString").value || $("host").value;
        if ($("port")) $("port").value = String(next.port ?? "1521");
        return;
      }

      // network types
      maybeSet("host", next.host ?? "", prev.host);
      maybeSet("port", String(next.port ?? ""), String(prev.port ?? ""));
      maybeSet("user", next.user ?? "", prev.user);
      maybeSet("database", next.database ?? "", prev.database);
      if (nextType === "redis") {
        maybeSet("redisDatabase", next.redisDatabase ?? "0", prev.redisDatabase);
      }
    }

    function setVisible(id, visible) {
      const el = $(id);
      if (!el) return;
      el.classList.toggle("hidden", !visible);
    }

    function onTypeChange() {
      const type = $("type").value;
      const isSqlite = type === "sqlite";
      const isOracle = type === "oracle";
      const isRedis = type === "redis";
      applyDefaults(type, lastType);
      lastType = type;

      setVisible("group-sqlite", isSqlite);
      setVisible("group-oracle", isOracle);
      setVisible("group-redis", isRedis);
      setVisible("group-network", !isSqlite);

      // Network group rows per type
      setVisible("row-host", !isSqlite && !isOracle);
      setVisible("row-port", !isSqlite && !isOracle);
      setVisible("row-user", !isSqlite && !isRedis);
      setVisible("row-database", !isSqlite && !isRedis);
      setVisible("row-ssl", !isSqlite && !isOracle); // Redis/MySQL/Postgres only

      // Oracle uses connect string + user/database + password
      if (isOracle) {
        setVisible("group-network", true);
      }

      // Redis uses host/port/ssl + db index + password
      if (isRedis) {
        $("user").value = "";
        $("database").value = "";
      }

      // SQLite doesn't use password.
      setVisible("group-password", !isSqlite);
    }

    $("type").addEventListener("change", onTypeChange);
    $("showPassword").addEventListener("change", () => {
      $("password").type = $("showPassword").checked ? "text" : "password";
    });
    $("showSshPassword").addEventListener("change", () => {
      $("sshPassword").type = $("showSshPassword").checked ? "text" : "password";
    });
    $("sshEnabled").addEventListener("change", () => {
      lastSshEnabled = Boolean($("sshEnabled").checked);
      setVisible("group-ssh", lastSshEnabled);
    });
    onTypeChange();
    setVisible("group-ssh", lastSshEnabled);

    function collect() {
      const type = $("type").value;
      return {
        name: $("name").value,
        type,
        host: $("host")?.value,
        port: $("port")?.value,
        user: $("user")?.value,
        database: $("database")?.value,
        ssl: $("ssl")?.checked,
        sqliteFilePath: $("sqliteFilePath")?.value,
        oracleConnectString: $("oracleConnectString")?.value || $("host")?.value,
        oraclePrivilege: $("oraclePrivilege")?.value,
        redisDatabase: $("redisDatabase")?.value,
        password: $("password")?.value,
        sshEnabled: $("sshEnabled")?.checked,
        sshHost: $("sshHost")?.value,
        sshPort: $("sshPort")?.value,
        sshUser: $("sshUser")?.value,
        sshPrivateKeyPath: $("sshPrivateKeyPath")?.value,
        sshPassword: $("sshPassword")?.value,
        sshRemoteHost: $("sshRemoteHost")?.value,
        sshRemotePort: $("sshRemotePort")?.value,
        resetPassword: $("resetPassword")?.checked
      };
    }

    $("save").addEventListener("click", () => {
      errorEl.textContent = "";
      vscode.postMessage({ type: "save", payload: collect() });
    });
    $("test").addEventListener("click", () => {
      errorEl.textContent = "";
      vscode.postMessage({ type: "test", payload: collect() });
    });
    $("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg?.type === "error") errorEl.textContent = msg.message || "Error";
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
