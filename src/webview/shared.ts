export type VsCodeApi = {
  postMessage(message: unknown): void;
};

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

export function readState<T>(): T {
  const stateEl = document.getElementById("mcState");
  const encoded = stateEl?.textContent?.trim() ?? "";
  if (!encoded) {
    throw new Error("Missing webview state.");
  }
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
