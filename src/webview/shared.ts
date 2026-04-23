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
  return JSON.parse(atob(encoded)) as T;
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
