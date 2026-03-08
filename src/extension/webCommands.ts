import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { WebLinkStore } from "../web/webLinkStore";
import type { ExplorerNode } from "../ui/explorerView";

type RefreshableView = {
  refresh(node?: ExplorerNode): void;
};

type WebCommandsDeps = {
  webLinkStore: WebLinkStore;
  view: RefreshableView;
  normalizeHttpUrl(input: string): string | undefined;
  openInternalBrowser(url: string): Promise<void>;
  previewMarkdownFile(uri?: vscode.Uri): Promise<void>;
};

async function pickOrPromptWebLink(store: WebLinkStore, node?: ExplorerNode): Promise<{ name: string; url: string } | undefined> {
  if (node?.kind === "webLink") {
    return { name: node.link.name, url: node.link.url };
  }
  const all = store.list();
  if (all.length === 0) {
    vscode.window.showInformationMessage("No saved web links. Add one first.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    all.map((link) => ({ label: link.name, description: link.url, link })),
    { title: "Select web link", ignoreFocusOut: true }
  );
  return picked ? { name: picked.link.name, url: picked.link.url } : undefined;
}

export function registerWebCommands(context: vscode.ExtensionContext, deps: WebCommandsDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.addWebLink", async () => {
      const urlInput = await vscode.window.showInputBox({
        title: "Add web link",
        prompt: "Enter URL (http/https)",
        ignoreFocusOut: true
      });
      if (urlInput === undefined) return;
      const normalizedUrl = deps.normalizeHttpUrl(urlInput);
      if (!normalizedUrl) {
        vscode.window.showErrorMessage("Invalid URL. Use http:// or https://");
        return;
      }
      const name = await vscode.window.showInputBox({
        title: "Link name",
        prompt: "Display name in the Web Links view",
        value: normalizedUrl,
        ignoreFocusOut: true
      });
      if (!name?.trim()) return;
      const next = [...deps.webLinkStore.list(), { id: randomUUID(), name: name.trim(), url: normalizedUrl }];
      await deps.webLinkStore.saveAll(next);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.editWebLink", async (node?: ExplorerNode) => {
      const link = node?.kind === "webLink" ? node.link : undefined;
      if (!link) return;
      const nextUrlInput = await vscode.window.showInputBox({
        title: `Edit web link: ${link.name}`,
        prompt: "URL (http/https)",
        value: link.url,
        ignoreFocusOut: true
      });
      if (nextUrlInput === undefined) return;
      const normalizedUrl = deps.normalizeHttpUrl(nextUrlInput);
      if (!normalizedUrl) {
        vscode.window.showErrorMessage("Invalid URL. Use http:// or https://");
        return;
      }
      const nextName = await vscode.window.showInputBox({
        title: `Edit web link: ${link.name}`,
        prompt: "Display name in the Web Links view",
        value: link.name,
        ignoreFocusOut: true
      });
      if (nextName === undefined) return;
      const updated = { ...link, name: nextName.trim() || link.name, url: normalizedUrl };
      await deps.webLinkStore.saveAll(deps.webLinkStore.list().map((item) => (item.id === link.id ? updated : item)));
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeWebLink", async (node?: ExplorerNode) => {
      const link = node?.kind === "webLink" ? node.link : undefined;
      if (!link) return;
      await deps.webLinkStore.saveAll(deps.webLinkStore.list().filter((item) => item.id !== link.id));
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.openInternalBrowser", async () => {
      const urlInput = await vscode.window.showInputBox({
        title: "Open internal browser",
        prompt: "Enter URL (http/https)",
        ignoreFocusOut: true
      });
      if (urlInput === undefined) return;
      const normalizedUrl = deps.normalizeHttpUrl(urlInput);
      if (!normalizedUrl) {
        vscode.window.showErrorMessage("Invalid URL. Use http:// or https://");
        return;
      }
      await deps.openInternalBrowser(normalizedUrl);
    }),

    vscode.commands.registerCommand("moreConnect.openInternalBrowserFromLink", async (node?: ExplorerNode) => {
      const picked = await pickOrPromptWebLink(deps.webLinkStore, node);
      if (!picked) return;
      await deps.openInternalBrowser(picked.url);
    }),

    vscode.commands.registerCommand("moreConnect.openExternalBrowser", async (node?: ExplorerNode) => {
      const targetUrl = node?.kind === "webLink" ? node.link.url : undefined;
      if (targetUrl) {
        await vscode.env.openExternal(vscode.Uri.parse(targetUrl, true));
        return;
      }
      const urlInput = await vscode.window.showInputBox({
        title: "Open external browser",
        prompt: "Enter URL (http/https)",
        ignoreFocusOut: true
      });
      if (urlInput === undefined) return;
      const normalizedUrl = deps.normalizeHttpUrl(urlInput);
      if (!normalizedUrl) {
        vscode.window.showErrorMessage("Invalid URL. Use http:// or https://");
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(normalizedUrl, true));
    }),

    vscode.commands.registerCommand("moreConnect.openBrowserDevTools", async () => {
      const commands = await vscode.commands.getCommands(true);
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = activeTab?.input;
      const isWebviewTab = !!input && input instanceof vscode.TabInputWebview;

      if (isWebviewTab && commands.includes("workbench.action.webview.openDeveloperTools")) {
        try {
          await vscode.commands.executeCommand("workbench.action.webview.openDeveloperTools");
          return;
        } catch {}
      }

      for (const id of ["workbench.action.toggleDevTools", "workbench.action.toggleDeveloperTools"]) {
        if (!commands.includes(id)) continue;
        try {
          await vscode.commands.executeCommand(id);
          return;
        } catch {}
      }
      vscode.window.showErrorMessage("Developer tools command is unavailable in this VS Code build.");
    }),

    vscode.commands.registerCommand("moreConnect.previewMarkdownFile", async (uri?: vscode.Uri) => {
      await deps.previewMarkdownFile(uri);
    })
  );
}
