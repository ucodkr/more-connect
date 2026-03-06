import { Environment } from "./models";

export function uid (prefix = ""): string {
  const bytes = new Uint8Array(8);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const id = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return prefix ? `${prefix}_${id}` : id;
}

export function now (): number {
  return Date.now();
}

export function interpolate (template: string, env?: Environment): string {
  if (!template) return template;
  const vars = new Map<string, string>();
  if (env?.vars) {
    for (const v of env.vars) {
      if (v.enabled !== false) {
        const key = v.key?.trim();
        if (key) vars.set(key, v.value);
      }
    }
  }
  const replaceVar = (match: string, name: string) => {
    const v = vars.get(String(name).trim());
    return v !== undefined ? v : match;
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_\-\.]+)\s*\}\}/g, replaceVar);
}

export function redact (value: string): string {
  if (!value) return value;
  if (value.length <= 6) return "***";
  return value.slice(0, 2) + "***" + value.slice(-2);
}
