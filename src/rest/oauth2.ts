import * as vscode from "vscode";
import crypto from "node:crypto";
import http from "node:http";
import { fetch } from "undici";

export type OAuthToken = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  obtained_at: number;
};

function b64url(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest();
}

async function startLocalCallbackServer(): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  dispose: () => void;
}> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    let done = false;

    const waitForCode = () =>
      new Promise<string>((res, rej) => {
        server.on("request", (req, resp) => {
          try {
            const u = new URL(req.url || "/", "http://127.0.0.1");
            if (u.pathname !== "/callback") {
              resp.writeHead(404);
              resp.end("Not found");
              return;
            }
            const code = u.searchParams.get("code");
            const err = u.searchParams.get("error");
            if (err) {
              resp.writeHead(400, { "content-type": "text/html; charset=utf-8" });
              resp.end(`<h3>OAuth2 error</h3><pre>${err}</pre>`);
              rej(new Error(err));
              return;
            }
            if (!code) {
              resp.writeHead(400);
              resp.end("Missing code");
              rej(new Error("Missing code"));
              return;
            }
            resp.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            resp.end(`<h3>Authorized</h3><p>You can close this tab and return to VS Code.</p>`);
            done = true;
            res(code);
          } catch (e: any) {
            rej(e);
          }
        });
      });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("Failed to bind callback server"));
      const redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      resolve({
        redirectUri,
        waitForCode,
        dispose: () => {
          try { server.close(); } catch {}
          done = true;
        },
      });
    });
  });
}

export async function oauthAuthorizeCodePKCE(args: {
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
  audience?: string;
  clientSecret?: string; // optional
}): Promise<OAuthToken> {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(sha256(verifier));

  const cb = await startLocalCallbackServer();
  try {
    const authUrl = new URL(args.authorizationUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", args.clientId);
    authUrl.searchParams.set("redirect_uri", cb.redirectUri);
    if (args.scope) authUrl.searchParams.set("scope", args.scope);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    if (args.audience) authUrl.searchParams.set("audience", args.audience);

    await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
    const code = await cb.waitForCode();

    const tokenRes = await fetch(args.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: args.clientId,
        code,
        redirect_uri: cb.redirectUri,
        code_verifier: verifier,
        ...(args.clientSecret ? { client_secret: args.clientSecret } : {}),
      }).toString(),
    });

    const text = await tokenRes.text();
    if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
    const json = JSON.parse(text);
    return { ...json, obtained_at: Date.now() } as OAuthToken;
  } finally {
    cb.dispose();
  }
}

export async function oauthClientCredentials(args: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  audience?: string;
}): Promise<OAuthToken> {
  const tokenRes = await fetch(args.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      ...(args.scope ? { scope: args.scope } : {}),
      ...(args.audience ? { audience: args.audience } : {}),
    }).toString(),
  });

  const text = await tokenRes.text();
  if (!tokenRes.ok) throw new Error(`Client credentials failed (${tokenRes.status}): ${text}`);
  const json = JSON.parse(text);
  return { ...json, obtained_at: Date.now() } as OAuthToken;
}

export async function oauthRefreshToken(args: {
  tokenUrl: string;
  clientId: string;
  refreshToken: string;
  scope?: string;
  audience?: string;
  clientSecret?: string;
}): Promise<OAuthToken> {
  // Many providers accept: grant_type=refresh_token, refresh_token, client_id (+ optional secret)
  const tokenRes = await fetch(args.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId,
      ...(args.clientSecret ? { client_secret: args.clientSecret } : {}),
      ...(args.scope ? { scope: args.scope } : {}),
      ...(args.audience ? { audience: args.audience } : {}),
    }).toString(),
  });

  const text = await tokenRes.text();
  if (!tokenRes.ok) throw new Error(`Refresh failed (${tokenRes.status}): ${text}`);
  const json = JSON.parse(text);
  // Some providers omit refresh_token on refresh; preserve old one in caller if needed
  return { ...json, obtained_at: Date.now() } as OAuthToken;
}

export function isExpired(tok: OAuthToken): boolean {
  if (!tok.expires_in) return false;
  const expAt = tok.obtained_at + tok.expires_in * 1000;
  // refresh 30s early
  return Date.now() > expAt - 30_000;
}
