import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { OllamaStore } from "../ollama/ollamaStore";
import type { OllamaEndpoint } from "../types";
import type { InfoPanel } from "../ui/infoPanel";
import type { ExplorerNode } from "../ui/explorerView";
import type { createOllamaController } from "./ollamaController";

type RefreshableView = {
  refresh(node?: ExplorerNode): void;
};

type OllamaCommandsDeps = {
  ollamaStore: OllamaStore;
  ollamaController: ReturnType<typeof createOllamaController>;
  view: RefreshableView;
  infoPanel: InfoPanel;
  normalizeOllamaUrl(input: string): string | undefined;
  llmProviderLabel(endpoint: OllamaEndpoint): string;
  isOllamaProvider(endpoint: OllamaEndpoint): boolean;
  escapeHtml(value: string): string;
  renderTable(headers: string[], rows: string[][]): string;
};

export function registerOllamaCommands(context: vscode.ExtensionContext, deps: OllamaCommandsDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("moreConnect.addOllamaConnection", async () => {
      const provider = await deps.ollamaController.pickLlmProvider("ollama");
      if (!provider) return;
      const urlInput = await vscode.window.showInputBox({
        title: `Add ${provider === "vllm" ? "vLLM" : "Ollama"} endpoint`,
        prompt: provider === "vllm" ? "Enter vLLM URL (e.g. http://localhost:8000)" : "Enter Ollama URL (e.g. http://localhost:11434)",
        ignoreFocusOut: true
      });
      if (urlInput === undefined) return;
      const normalizedUrl = deps.normalizeOllamaUrl(urlInput);
      if (!normalizedUrl) {
        vscode.window.showErrorMessage("Invalid URL. Use http://host:port");
        return;
      }
      const name = await vscode.window.showInputBox({
        title: "Endpoint name",
        prompt: "Display name in the Ollama/vLLM view",
        value: normalizedUrl,
        ignoreFocusOut: true
      });
      if (!name?.trim()) return;
      const next = [...deps.ollamaStore.list(), { id: randomUUID(), name: name.trim(), url: normalizedUrl, provider }];
      await deps.ollamaStore.saveAll(next);
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.editOllamaConnection", async (node?: ExplorerNode) => {
      const endpoint = node?.kind === "ollama" ? node.endpoint : undefined;
      if (!endpoint) return;
      const provider = await deps.ollamaController.pickLlmProvider(endpoint.provider === "vllm" ? "vllm" : "ollama");
      if (!provider) return;
      const nextUrlInput = await vscode.window.showInputBox({
        title: `Edit ${deps.llmProviderLabel(endpoint)} endpoint: ${endpoint.name}`,
        prompt: "Endpoint URL (http/https)",
        value: endpoint.url,
        ignoreFocusOut: true
      });
      if (nextUrlInput === undefined) return;
      const normalizedUrl = deps.normalizeOllamaUrl(nextUrlInput);
      if (!normalizedUrl) {
        vscode.window.showErrorMessage("Invalid URL. Use http://host:port");
        return;
      }
      const nextName = await vscode.window.showInputBox({
        title: `Edit Ollama endpoint: ${endpoint.name}`,
        prompt: "Display name in the Ollama view",
        value: endpoint.name,
        ignoreFocusOut: true
      });
      if (nextName === undefined) return;
      const updated = { ...endpoint, name: nextName.trim() || endpoint.name, url: normalizedUrl, provider };
      await deps.ollamaStore.saveAll(deps.ollamaStore.list().map((item) => (item.id === endpoint.id ? updated : item)));
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.removeOllamaConnection", async (node?: ExplorerNode) => {
      const endpoint = node?.kind === "ollama" ? node.endpoint : undefined;
      if (!endpoint) return;
      await deps.ollamaStore.saveAll(deps.ollamaStore.list().filter((item) => item.id !== endpoint.id));
      deps.view.refresh();
    }),

    vscode.commands.registerCommand("moreConnect.refreshOllamaModels", async (node?: ExplorerNode) => {
      const endpoint = await deps.ollamaController.pickOllamaEndpoint(node);
      if (!endpoint) return;
      try {
        const models = await deps.ollamaController.fetchOllamaModels(endpoint);
        deps.view.refresh(node?.kind === "ollama" ? node : undefined);
        vscode.window.showInformationMessage(`${deps.llmProviderLabel(endpoint)} models: ${models.length}`);
      } catch (e) {
        vscode.window.showErrorMessage(`${deps.llmProviderLabel(endpoint)} list failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.ollamaPullModel", async (node?: ExplorerNode) => {
      const endpoint = await deps.ollamaController.pickOllamaEndpoint(node);
      if (!endpoint) return;
      if (!deps.isOllamaProvider(endpoint)) {
        vscode.window.showInformationMessage("Model pull is only supported for Ollama endpoints.");
        return;
      }

      const modelFromNode = node?.kind === "ollamaModel" ? node.model : undefined;
      const modelInput = await vscode.window.showInputBox({
        title: `Pull model (${endpoint.name})`,
        prompt: "Model name (e.g. llama3.2:3b)",
        value: modelFromNode,
        ignoreFocusOut: true
      });
      if (!modelInput?.trim()) return;

      try {
        const result = await deps.ollamaController.pullModel(endpoint, modelInput.trim());
        deps.view.refresh();
        vscode.window.showInformationMessage(`Model pull: ${result.status}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Model pull failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.ollamaDeleteModel", async (node?: ExplorerNode) => {
      const endpoint = await deps.ollamaController.pickOllamaEndpoint(node);
      if (!endpoint) return;
      if (!deps.isOllamaProvider(endpoint)) {
        vscode.window.showInformationMessage("Model delete is only supported for Ollama endpoints.");
        return;
      }
      const model = node?.kind === "ollamaModel" ? node.model : await deps.ollamaController.pickOllamaModel(endpoint);
      if (!model) return;
      const confirm = await vscode.window.showWarningMessage(`Delete Ollama model "${model}" on ${endpoint.name}?`, { modal: true }, "Delete");
      if (confirm !== "Delete") return;
      try {
        await deps.ollamaController.deleteModel(endpoint, model);
        deps.view.refresh();
        vscode.window.showInformationMessage(`Model deleted: ${model}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Model delete failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.copyOllamaModelName", async (node?: ExplorerNode) => {
      const endpoint = await deps.ollamaController.pickOllamaEndpoint(node);
      if (!endpoint) return;
      const model = node?.kind === "ollamaModel" ? node.model : await deps.ollamaController.pickOllamaModel(endpoint);
      if (!model) return;
      await vscode.env.clipboard.writeText(model);
      vscode.window.showInformationMessage(`Copied model: ${model}`);
    }),

    vscode.commands.registerCommand("moreConnect.showOllamaModelInfo", async (node?: ExplorerNode) => {
      const endpoint = await deps.ollamaController.pickOllamaEndpoint(node);
      if (!endpoint) return;
      const model = node?.kind === "ollamaModel" ? node.model : await deps.ollamaController.pickOllamaModel(endpoint);
      if (!model) return;
      try {
        const infos = await deps.ollamaController.fetchOllamaModelInfoMap(endpoint);
        const info = await deps.ollamaController.enrichOllamaModelContextLimit(endpoint, model, infos[model]);
        const sizeText = info.sizeBytes !== undefined ? `${(info.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB` : "-";
        const body = [
          `<h1>Model: <code>${deps.escapeHtml(model)}</code></h1>`,
          `<h2>Endpoint</h2>`,
          `<p>${deps.escapeHtml(endpoint.name)} (${deps.escapeHtml(endpoint.url)})</p>`,
          `<h2>Details</h2>`,
          deps.renderTable(
            ["field", "value"],
            [
              ["size", sizeText],
              ["context limit", info.contextLimit !== undefined ? String(info.contextLimit) : "-"],
              ["parameter size", info.parameterSize ?? "-"],
              ["quantization", info.quantization ?? "-"],
              ["family", info.family ?? "-"],
              ["format", info.format ?? "-"]
            ]
          )
        ].join("\n");
        deps.infoPanel.show(`Ollama Model: ${model}`, body);
      } catch (e) {
        vscode.window.showErrorMessage(`Model info failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("moreConnect.ollamaChat", async (node?: ExplorerNode) => {
      const endpoint = await deps.ollamaController.pickOllamaEndpoint(node);
      if (!endpoint) return;

      const modelFromNode = node?.kind === "ollamaModel" ? node.model : undefined;
      let model = modelFromNode;
      if (!model) {
        try {
          model = await deps.ollamaController.pickOllamaModel(endpoint);
        } catch (e) {
          vscode.window.showErrorMessage(`Model list failed: ${(e as Error).message}`);
          return;
        }
      }
      if (!model) return;
      await deps.ollamaController.showOllamaChat(endpoint, model);
    })
  );
}
