import type { Collection, Environment, FolderItem, KeyValue, MultipartField, RequestItem } from "./models";
import { uid } from "./utils";

const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

type PostmanItem = {
  name: string;
  item?: PostmanItem[];
  request?: any;
  response?: any[];
};

function kvToPostman (list: KeyValue[] | undefined) {
  return (list || []).map((kv) => ({
    key: kv.key,
    value: kv.value,
    disabled: kv.enabled === false ? true : undefined,
  })).filter((kv) => kv.key);
}

function urlToPostman (req: RequestItem) {
  const raw = req.url || "";
  try {
    const u = new URL(raw);
    const query: any[] = [];
    u.searchParams.forEach((value, key) => {
      query.push({ key, value });
    });
    for (const kv of kvToPostman(req.params)) query.push(kv);
    return {
      raw,
      protocol: u.protocol.replace(":", ""),
      host: u.hostname.split("."),
      port: u.port || undefined,
      path: u.pathname.split("/").filter(Boolean),
      query: query.length ? query : undefined,
    };
  } catch {
    const query = kvToPostman(req.params);
    return {
      raw,
      query: query.length ? query : undefined,
    };
  }
}

function bodyToPostman (req: RequestItem) {
  const body = req.body;
  if (!body || body.type === "none") return undefined;
  if (body.type === "json") {
    return {
      mode: "raw",
      raw: body.json ?? "",
      options: { raw: { language: "json" } },
    };
  }
  if (body.type === "raw") {
    return {
      mode: "raw",
      raw: body.raw ?? "",
      options: { raw: { language: "text" } },
    };
  }
  if (body.type === "x-www-form-urlencoded") {
    return {
      mode: "urlencoded",
      urlencoded: kvToPostman(body.fields || []),
    };
  }
  if (body.type === "multipart") {
    const formdata = (body.fields || []).map((f: MultipartField) => {
      if (f.isFile) {
        return {
          key: f.key,
          type: "file",
          src: f.fileName || "",
          disabled: f.enabled === false ? true : undefined,
        };
      }
      return {
        key: f.key,
        value: f.value ?? "",
        type: "text",
        disabled: f.enabled === false ? true : undefined,
      };
    }).filter((f) => f.key);
    return {
      mode: "formdata",
      formdata,
    };
  }
  return undefined;
}

function authToPostman (req: RequestItem) {
  switch (req.auth.type) {
    case "bearer":
      return {
        type: "bearer",
        bearer: [{ key: "token", value: req.auth.token || "" }],
      };
    case "basic":
      return {
        type: "basic",
        basic: [
          { key: "username", value: req.auth.username || "" },
          { key: "password", value: req.auth.password || "" },
        ],
      };
    case "apiKey":
      return {
        type: "apikey",
        apikey: [
          { key: "key", value: req.auth.name || "" },
          { key: "value", value: req.auth.value || "" },
          { key: "in", value: req.auth.in || "header" },
        ],
      };
    case "oauth2":
      return { type: "oauth2" };
    default:
      return undefined;
  }
}

function requestToPostman (item: RequestItem): PostmanItem {
  const request: any = {
    method: item.method,
    header: kvToPostman(item.headers),
    url: urlToPostman(item),
  };
  const body = bodyToPostman(item);
  if (body) request.body = body;
  const auth = authToPostman(item);
  if (auth) request.auth = auth;
  return { name: item.name, request, response: [] };
}

function itemsToPostman (items: Array<FolderItem | RequestItem>): PostmanItem[] {
  return items.map((it) => {
    if ((it as FolderItem).items) {
      const f = it as FolderItem;
      return { name: f.name, item: itemsToPostman(f.items || []) };
    }
    return requestToPostman(it as RequestItem);
  });
}

function postmanToUrl (raw: any): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    if (raw.raw) return String(raw.raw);
    const protocol = raw.protocol ? `${raw.protocol}://` : "";
    const host = Array.isArray(raw.host) ? raw.host.join(".") : (raw.host || "");
    const path = Array.isArray(raw.path) ? `/${raw.path.join("/")}` : (raw.path ? `/${raw.path}` : "");
    const query = Array.isArray(raw.query)
      ? raw.query.map((q: any) => `${q.key}=${q.value ?? ""}`).join("&")
      : "";
    return `${protocol}${host}${path}${query ? `?${query}` : ""}`;
  }
  return "";
}

function postmanToParams (urlObj: any): KeyValue[] {
  if (!urlObj || !Array.isArray(urlObj.query)) return [];
  return urlObj.query.map((q: any) => ({
    key: q.key || "",
    value: q.value ?? "",
    enabled: q.disabled ? false : true,
  })).filter((q: KeyValue) => q.key);
}

function postmanToHeaders (headers: any): KeyValue[] {
  if (!Array.isArray(headers)) return [];
  return headers.map((h: any) => ({
    key: h.key || "",
    value: h.value ?? "",
    enabled: h.disabled ? false : true,
  })).filter((h: KeyValue) => h.key);
}

function postmanToBody (body: any) {
  if (!body) return { type: "none" as const };
  if (body.mode === "raw") {
    const language = body.options?.raw?.language;
    if (language === "json") return { type: "json" as const, json: body.raw ?? "" };
    return { type: "raw" as const, raw: body.raw ?? "", contentType: "text/plain; charset=utf-8" };
  }
  if (body.mode === "urlencoded") {
    const fields = (body.urlencoded || []).map((f: any) => ({
      key: f.key || "",
      value: f.value ?? "",
      enabled: f.disabled ? false : true,
    })).filter((f: KeyValue) => f.key);
    return { type: "x-www-form-urlencoded" as const, fields };
  }
  if (body.mode === "formdata") {
    const fields = (body.formdata || []).map((f: any) => {
      if (f.type === "file") {
        const fileName = Array.isArray(f.src) ? f.src[0] : f.src;
        return {
          key: f.key || "",
          value: "",
          enabled: f.disabled ? false : true,
          isFile: true,
          fileName: fileName || "",
        };
      }
      return {
        key: f.key || "",
        value: f.value ?? "",
        enabled: f.disabled ? false : true,
      };
    }).filter((f: MultipartField) => f.key);
    return { type: "multipart" as const, fields };
  }
  return { type: "none" as const };
}

function postmanToAuth (auth: any) {
  if (!auth || !auth.type) return { type: "none" as const };
  if (auth.type === "bearer") {
    const token = auth.bearer?.find((b: any) => b.key === "token")?.value ?? "";
    return { type: "bearer" as const, token };
  }
  if (auth.type === "basic") {
    const u = auth.basic?.find((b: any) => b.key === "username")?.value ?? "";
    const p = auth.basic?.find((b: any) => b.key === "password")?.value ?? "";
    return { type: "basic" as const, username: u, password: p };
  }
  if (auth.type === "apikey") {
    const key = auth.apikey?.find((b: any) => b.key === "key")?.value ?? "";
    const value = auth.apikey?.find((b: any) => b.key === "value")?.value ?? "";
    const where = auth.apikey?.find((b: any) => b.key === "in")?.value ?? "header";
    const inVal = where === "query" ? "query" : "header";
    return { type: "apiKey" as const, in: inVal, name: key, value };
  }
  return { type: "none" as const };
}

function postmanItemToRequest (item: any): RequestItem | null {
  if (!item?.request) return null;
  const req = item.request;
  const now = Date.now();
  return {
    id: uid("req"),
    type: "request",
    name: item.name || req.name || "Imported Request",
    method: (req.method || "GET").toUpperCase(),
    url: postmanToUrl(req.url),
    params: postmanToParams(req.url),
    headers: postmanToHeaders(req.header),
    body: postmanToBody(req.body),
    auth: postmanToAuth(req.auth),
    createdAt: now,
    updatedAt: now,
  };
}

function postmanItemsToFolders (items: any[]): Array<FolderItem | RequestItem> {
  const out: Array<FolderItem | RequestItem> = [];
  for (const it of items || []) {
    if (Array.isArray(it.item)) {
      out.push({
        id: uid("fld"),
        type: "folder",
        name: it.name || "Folder",
        items: postmanItemsToFolders(it.item),
      });
      continue;
    }
    const req = postmanItemToRequest(it);
    if (req) out.push(req);
  }
  return out;
}

export function exportPostmanCollection (collections: Collection[]) {
  const name = collections.length === 1 ? collections[0]?.name || "MoreRestTools Export" : "MoreRestTools Export";
  return {
    info: { name, schema: POSTMAN_SCHEMA },
    item: collections.map((c) => ({
      name: c.name,
      item: itemsToPostman(c.items || []),
    })),
  };
}

export function importPostmanCollection (doc: any): Collection {
  const name = doc?.info?.name || "Imported Collection";
  const items = postmanItemsToFolders(doc?.item || []);
  return {
    id: uid("col"),
    name,
    items,
  };
}

export function exportPostmanEnvironment (env: Environment) {
  return {
    id: env.id,
    name: env.name,
    values: (env.vars || []).map((v) => ({
      key: v.key,
      value: v.value,
      enabled: v.enabled !== false,
    })),
  };
}

export function importPostmanEnvironment (doc: any): Environment {
  const name = doc?.name || "Imported Environment";
  const vars = (doc?.values || []).map((v: any) => ({
    id: uid("envv"),
    key: v.key || "",
    value: v.value ?? "",
    enabled: v.enabled !== false,
  })).filter((v: any) => v.key);
  return {
    id: uid("env"),
    name,
    vars,
  };
}

export function isPostmanCollection (doc: any): boolean {
  return !!doc?.info?.schema && String(doc.info.schema).includes("collection/v2");
}

export function isPostmanEnvironment (doc: any): boolean {
  return Array.isArray(doc?.values) && typeof doc?.name === "string";
}
