import { fetch, Headers } from "undici";
import type { Environment, KeyValue, MultipartField, RequestItem, SendResult } from "./models";
import { interpolate } from "./utils";

function isTextLikeContentType (contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (!ct) return true;
  if (ct.startsWith("text/")) return true;
  if (ct.includes("application/json") || /\+json\b/.test(ct)) return true;
  if (ct.includes("application/xml") || /\+xml\b/.test(ct)) return true;
  if (ct.includes("application/x-www-form-urlencoded")) return true;
  if (ct.includes("application/javascript")) return true;
  if (ct.includes("application/graphql")) return true;
  return false;
}

function toRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => (out[k] = v));
  return out;
}

function kvEnabled(list: KeyValue[], env?: Environment): Array<[string, string]> {
  return (list || [])
    .filter((x) => x.enabled && x.key)
    .map((x) => [interpolate(x.key, env), interpolate(x.value ?? "", env)]);
}

function multipartEnabled(list: MultipartField[], env?: Environment): MultipartField[] {
  return (list || [])
    .filter((x) => x.enabled && x.key)
    .map((x) => ({
      ...x,
      key: interpolate(x.key, env),
      value: x.value ? interpolate(x.value, env) : x.value,
    }));
}

export async function sendRequest(
  req: RequestItem,
  env?: Environment,
  bearerFromOAuth?: string,
  signal?: AbortSignal
): Promise<SendResult> {
  const t0 = Date.now();
  try {
    const urlObj = new URL(interpolate(req.url, env));

    // query params (merge with existing)
    for (const [k, v] of kvEnabled(req.params, env)) {
      urlObj.searchParams.set(k, v);
    }

    const headers = new Headers();

    // headers
    for (const [k, v] of kvEnabled(req.headers, env)) {
      headers.set(k, v);
    }

    // auth
    switch (req.auth.type) {
      case "bearer":
        if (req.auth.token) headers.set("Authorization", `Bearer ${interpolate(req.auth.token, env)}`);
        break;
      case "basic": {
        const u = interpolate(req.auth.username, env);
        const p = interpolate(req.auth.password, env);
        const b64 = Buffer.from(`${u}:${p}`, "utf8").toString("base64");
        headers.set("Authorization", `Basic ${b64}`);
        break;
      }
      case "apiKey": {
        const name = interpolate(req.auth.name, env);
        const value = interpolate(req.auth.value, env);
        if (req.auth.in === "header") headers.set(name, value);
        else urlObj.searchParams.set(name, value);
        break;
      }
      case "oauth2":
        if (bearerFromOAuth) headers.set("Authorization", `Bearer ${bearerFromOAuth}`);
        break;
      default:
        break;
    }

    // body
    let body: any = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.body.type === "json") {
        body = interpolate(req.body.json ?? "", env);
        if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
      } else if (req.body.type === "raw") {
        body = interpolate(req.body.raw ?? "", env);
        if (!headers.has("content-type")) headers.set("content-type", req.body.contentType || "text/plain; charset=utf-8");
      } else if (req.body.type === "x-www-form-urlencoded") {
        const params = new URLSearchParams();
        for (const [k, v] of kvEnabled(req.body.fields || [], env)) params.append(k, v);
        body = params.toString();
        if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded; charset=utf-8");
      } else if (req.body.type === "multipart") {
        // Use undici FormData (Node 18+)
        const fd = new FormData();
        for (const field of multipartEnabled(req.body.fields || [], env)) {
          if (field.isFile && field.fileData) {
            const bytes = Buffer.from(field.fileData, "base64");
            const blob = new Blob([bytes], { type: field.contentType || "application/octet-stream" });
            fd.append(field.key, blob, field.fileName || "file");
          } else {
            fd.append(field.key, field.value ?? "");
          }
        }
        body = fd;
        // content-type boundary is set automatically by fetch
      }
    }

    const res = await fetch(urlObj.toString(), {
      method: req.method,
      headers,
      body,
      redirect: "follow",
      signal,
    });

    const contentType = res.headers.get("content-type") || "";
    const textLike = isTextLikeContentType(contentType);
    const ms = Date.now() - t0;
    if (textLike) {
      const text = await res.text();
      const size = Buffer.byteLength(text, "utf8");
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: toRecord(res.headers),
        bodyText: text,
        ms,
        size,
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: toRecord(res.headers),
      ms,
      size: buf.byteLength,
      bodyBase64: buf.toString("base64"),
      bodyIsBinary: true,
    };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return { ok: false, error: "Canceled", ms: Date.now() - t0 };
    }
    return { ok: false, error: e?.message ?? String(e), ms: Date.now() - t0 };
  }
}
