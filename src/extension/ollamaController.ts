import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { OllamaStore } from "../ollama/ollamaStore";
import type { LlmProvider, OllamaEndpoint } from "../types";
import type { ExplorerNode } from "../ui/explorerView";
import type { OllamaChatMessage, OllamaChatPanel } from "../ui/ollamaChatPanel";
import {
  llmProviderLabel,
  llmProviderOf,
  ollamaChatKey,
  ollamaMetaFromChatResponse,
  ollamaPanelKey,
  type OllamaModelInfo,
  type OllamaSession,
  parseContextLimitFromShow,
  toOllamaModelInfo
} from "./ollamaUtils";

type SessionStore = {
  listSessions(endpointId: string, model: string): OllamaSession[];
  saveSessions(endpointId: string, model: string, sessions: OllamaSession[]): Promise<void>;
  upsertSession(endpointId: string, model: string, sessionId: string, messages: OllamaChatMessage[]): Promise<OllamaSession>;
};

type OllamaControllerDeps = {
  ollamaStore: OllamaStore;
  ollamaChatPanel: OllamaChatPanel;
  sessionStore: SessionStore;
};

export function createOllamaController(deps: OllamaControllerDeps) {
  const ollamaChatsByKey = new Map<string, OllamaChatMessage[]>();
  const ollamaAbortByPanelKey = new Map<string, AbortController>();
  const ollamaPendingSessionByPanelKey = new Map<string, string>();

  async function fetchOllamaJson(endpoint: OllamaEndpoint, path: string, init?: RequestInit): Promise<any> {
    const url = `${endpoint.url}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      },
      body: init?.body,
      signal: init?.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
    const text = await res.text().catch(() => "");
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  async function fetchOllamaTagModels(endpoint: OllamaEndpoint): Promise<any[]> {
    const payload = await fetchOllamaJson(endpoint, "/api/tags");
    return Array.isArray(payload?.models) ? payload.models : [];
  }

  async function fetchOllamaModels(endpoint: OllamaEndpoint): Promise<string[]> {
    if (llmProviderOf(endpoint) === "vllm") {
      const payload = await fetchOllamaJson(endpoint, "/v1/models");
      const names = (Array.isArray(payload?.data) ? payload.data : [])
        .map((model: any) => String(model?.id ?? model?.model ?? "").trim())
        .filter(Boolean)
        .sort((a: string, b: string) => a.localeCompare(b));
      return Array.from(new Set(names.values()));
    }
    const models = await fetchOllamaTagModels(endpoint);
    const names = models
      .map((model: any) => String(model?.name ?? model?.model ?? "").trim())
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b));
    return Array.from(new Set(names.values()));
  }

  async function fetchOllamaModelInfoMap(endpoint: OllamaEndpoint): Promise<Record<string, OllamaModelInfo>> {
    if (llmProviderOf(endpoint) === "vllm") {
      const payload = await fetchOllamaJson(endpoint, "/v1/models");
      const map: Record<string, OllamaModelInfo> = {};
      for (const item of Array.isArray(payload?.data) ? payload.data : []) {
        const name = String(item?.id ?? item?.model ?? "").trim();
        if (!name) continue;
        map[name] = {
          name,
          family: String(item?.owned_by ?? "").trim() || "vllm",
          format: "openai-compatible",
          contextLimit: (() => {
            const n = Number(item?.max_model_len ?? item?.max_context_length ?? item?.context_length);
            return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
          })()
        };
      }
      return map;
    }
    const tags = await fetchOllamaTagModels(endpoint);
    const map: Record<string, OllamaModelInfo> = {};
    for (const tag of tags) {
      const name = String(tag?.name ?? tag?.model ?? "").trim();
      if (!name) continue;
      map[name] = toOllamaModelInfo(tag);
    }
    return map;
  }

  async function enrichOllamaModelContextLimit(
    endpoint: OllamaEndpoint,
    model: string,
    base: OllamaModelInfo | undefined
  ): Promise<OllamaModelInfo> {
    const info: OllamaModelInfo = { ...(base ?? { name: model }), name: model };
    if (llmProviderOf(endpoint) === "vllm") return info;
    try {
      const show = await fetchOllamaJson(endpoint, "/api/show", {
        method: "POST",
        body: JSON.stringify({ model })
      });
      const limit = parseContextLimitFromShow(show);
      if (limit !== undefined) info.contextLimit = limit;
    } catch {}
    return info;
  }

  async function pickOllamaEndpoint(node?: ExplorerNode): Promise<OllamaEndpoint | undefined> {
    if (node?.kind === "ollama") return node.endpoint;
    if (node?.kind === "ollamaModel") {
      return deps.ollamaStore.list().find((item) => item.id === node.endpointId);
    }
    const all = deps.ollamaStore.list();
    if (all.length === 0) {
      vscode.window.showInformationMessage("No Ollama/vLLM endpoint. Add one first.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      all.map((item) => ({
        label: item.name,
        description: `${llmProviderLabel(item)} • ${item.url}`,
        endpoint: item
      })),
      { title: "Select Ollama/vLLM endpoint", ignoreFocusOut: true }
    );
    return picked?.endpoint;
  }

  async function pickOllamaModel(endpoint: OllamaEndpoint, preselected?: string): Promise<string | undefined> {
    const promptModelInput = async (message?: string): Promise<string | undefined> => {
      if (message) vscode.window.showInformationMessage(message);
      const value = await vscode.window.showInputBox({
        title: `Model name (${endpoint.name})`,
        prompt: llmProviderOf(endpoint) === "vllm" ? "Enter vLLM model id (served model name)" : "Enter Ollama model name",
        value: preselected,
        ignoreFocusOut: true
      });
      return value?.trim() || undefined;
    };

    try {
      const models = await fetchOllamaModels(endpoint);
      if (models.length === 0) {
        if (llmProviderOf(endpoint) === "vllm") {
          return promptModelInput(`No model list from ${endpoint.name}. Enter the vLLM model id manually.`);
        }
        vscode.window.showInformationMessage(`No models on ${endpoint.name}. Pull a model first.`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        models.map((model) => ({ label: model, picked: model === preselected })),
        { title: `Select model (${endpoint.name})`, ignoreFocusOut: true }
      );
      return picked?.label;
    } catch (e) {
      if (llmProviderOf(endpoint) === "vllm") {
        return promptModelInput(`vLLM model list unavailable: ${(e as Error).message}`);
      }
      throw e;
    }
  }

  async function pickLlmProvider(initial?: LlmProvider): Promise<LlmProvider | undefined> {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Ollama", description: "Ollama API (/api/*)", value: "ollama" as const },
        { label: "vLLM", description: "OpenAI-compatible API (/v1/*)", value: "vllm" as const }
      ],
      {
        title: "Select LLM endpoint type",
        ignoreFocusOut: true,
        placeHolder: initial === "vllm" ? "Current: vLLM" : "Current: Ollama"
      }
    );
    return picked?.value;
  }

  async function pullModel(endpoint: OllamaEndpoint, model: string): Promise<{ status: string }> {
    const result = await fetchOllamaJson(endpoint, "/api/pull", {
      method: "POST",
      body: JSON.stringify({ model, stream: false })
    });
    return { status: String(result?.status ?? "done") };
  }

  async function deleteModel(endpoint: OllamaEndpoint, model: string): Promise<void> {
    try {
      await fetchOllamaJson(endpoint, "/api/delete", {
        method: "DELETE",
        body: JSON.stringify({ model })
      });
    } catch (e) {
      const message = String((e as Error).message ?? "");
      if (!message.includes("HTTP 405")) throw e;
      try {
        await fetchOllamaJson(endpoint, "/api/delete", {
          method: "POST",
          body: JSON.stringify({ model })
        });
      } catch {
        await fetchOllamaJson(endpoint, "/api/delete", {
          method: "POST",
          body: JSON.stringify({ name: model })
        });
      }
    }
  }

  async function streamOllamaChat(
    endpoint: OllamaEndpoint,
    body: { model: string; messages: OllamaChatMessage[] },
    panelKey: string,
    signal: AbortSignal
  ): Promise<{ content: string; finalChunk?: any }> {
    if (llmProviderOf(endpoint) === "vllm") {
      const url = `${endpoint.url}/v1/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let finalChunk: any;

      const processSseLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") return;
        try {
          const chunk = JSON.parse(data);
          const deltaValue = chunk?.choices?.[0]?.delta?.content;
          const delta =
            typeof deltaValue === "string"
              ? deltaValue
              : Array.isArray(deltaValue)
                ? deltaValue.map((part: any) => String(part?.text ?? "")).join("")
                : "";
          if (delta) {
            content += delta;
            deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.streamDelta", delta });
          }
          if (chunk?.usage || chunk?.choices?.[0]?.finish_reason) finalChunk = chunk;
        } catch {}
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split >= 0) {
            const event = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const line of event.split("\n")) processSseLine(line);
            split = buffer.indexOf("\n\n");
          }
        }
      } catch (e) {
        const partial = e as { partialContent?: string };
        partial.partialContent = content;
        throw e;
      }

      const tail = (buffer + decoder.decode()).trim();
      if (tail) {
        for (const line of tail.split("\n")) processSseLine(line);
      }

      return { content, finalChunk };
    }

    const url = `${endpoint.url}/api/chat`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finalChunk: any;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            try {
              const chunk = JSON.parse(line);
              const delta = String(chunk?.message?.content ?? "");
              if (delta) {
                content += delta;
                deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.streamDelta", delta });
              }
              if (chunk?.done) finalChunk = chunk;
            } catch {}
          }
          nl = buffer.indexOf("\n");
        }
      }
    } catch (e) {
      const partial = e as { partialContent?: string };
      partial.partialContent = content;
      throw e;
    }

    const tail = (buffer + decoder.decode()).trim();
    if (tail) {
      try {
        const chunk = JSON.parse(tail);
        const delta = String(chunk?.message?.content ?? "");
        if (delta) {
          content += delta;
          deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.streamDelta", delta });
        }
        if (chunk?.done) finalChunk = chunk;
      } catch {}
    }

    return { content, finalChunk };
  }

  async function showOllamaChat(endpoint: OllamaEndpoint, model: string): Promise<void> {
    let models: string[] = [];
    let modelInfos: Record<string, OllamaModelInfo> = {};
    try {
      models = await fetchOllamaModels(endpoint);
    } catch {}
    try {
      modelInfos = await fetchOllamaModelInfoMap(endpoint);
      modelInfos[model] = await enrichOllamaModelContextLimit(endpoint, model, modelInfos[model]);
    } catch {}
    if (!models.includes(model)) models = [...models, model];
    const sessions = deps.sessionStore.listSessions(endpoint.id, model);
    const selectedSession = sessions[0];
    const key = ollamaChatKey(endpoint.id, model);
    const messages = selectedSession?.messages ?? ollamaChatsByKey.get(key) ?? [];
    if (messages.length > 0) ollamaChatsByKey.set(key, messages);
    deps.ollamaChatPanel.show(ollamaPanelKey(endpoint.id), {
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      endpointUrl: endpoint.url,
      model,
      models,
      modelInfos,
      sessionId: selectedSession?.id,
      sessions: sessions.map((session) => ({ id: session.id, name: session.name, updatedAt: session.updatedAt })),
      messages
    });
  }

  async function handleOllamaChatPanelMessage(panelKey: string, msg: any): Promise<void> {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "ollama.stop") {
      const ctrl = ollamaAbortByPanelKey.get(panelKey);
      if (ctrl) ctrl.abort();
      return;
    }

    if (msg.type === "ollama.listModels") {
      const endpointId = String(msg.endpointId ?? "");
      const currentModel = String(msg.model ?? "").trim();
      if (!endpointId) return;
      const endpoint = deps.ollamaStore.list().find((item) => item.id === endpointId);
      if (!endpoint) return;
      try {
        const models = await fetchOllamaModels(endpoint);
        const mergedModels = currentModel && !models.includes(currentModel) ? [...models, currentModel] : models;
        let modelInfos: Record<string, OllamaModelInfo> = {};
        try {
          modelInfos = await fetchOllamaModelInfoMap(endpoint);
          if (currentModel) {
            modelInfos[currentModel] = await enrichOllamaModelContextLimit(endpoint, currentModel, modelInfos[currentModel]);
          }
        } catch {}
        deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.setModels", models: mergedModels, modelInfos });
        const sessions = deps.sessionStore.listSessions(endpointId, currentModel || mergedModels[0] || "");
        deps.ollamaChatPanel.postMessage(panelKey, {
          type: "ollama.setSessions",
          sessionId: sessions[0]?.id,
          sessions: sessions.map((session) => ({ id: session.id, name: session.name, updatedAt: session.updatedAt }))
        });
      } catch (e) {
        const fallbackModels = currentModel ? [currentModel] : [];
        deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.setModels", models: fallbackModels, modelInfos: {} });
        if (!currentModel) {
          deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.error", message: `Model list failed: ${(e as Error).message}` });
        }
      }
      return;
    }

    if (msg.type === "ollama.listSessions") {
      const endpointId = String(msg.endpointId ?? "");
      const model = String(msg.model ?? "").trim();
      if (!endpointId || !model) return;
      const sessions = deps.sessionStore.listSessions(endpointId, model);
      deps.ollamaChatPanel.postMessage(panelKey, {
        type: "ollama.setSessions",
        sessionId: sessions[0]?.id,
        sessions: sessions.map((session) => ({ id: session.id, name: session.name, updatedAt: session.updatedAt }))
      });
      return;
    }

    if (msg.type === "ollama.createSession") {
      const endpointId = String(msg.endpointId ?? "");
      const model = String(msg.model ?? "").trim();
      if (!endpointId || !model) return;
      const id = randomUUID();
      ollamaPendingSessionByPanelKey.set(panelKey, id);
      const created = await deps.sessionStore.upsertSession(endpointId, model, id, []);
      const sessions = deps.sessionStore.listSessions(endpointId, model);
      deps.ollamaChatPanel.postMessage(panelKey, {
        type: "ollama.setSessions",
        sessionId: created.id,
        sessions: sessions.map((session) => ({ id: session.id, name: session.name, updatedAt: session.updatedAt }))
      });
      deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.setConversation", model, sessionId: created.id, messages: [] });
      return;
    }

    if (msg.type === "ollama.selectSession") {
      const endpointId = String(msg.endpointId ?? "");
      const model = String(msg.model ?? "").trim();
      const sessionId = String(msg.sessionId ?? "").trim();
      if (!endpointId || !model || !sessionId) return;
      ollamaPendingSessionByPanelKey.delete(panelKey);
      const session = deps.sessionStore.listSessions(endpointId, model).find((item) => item.id === sessionId);
      deps.ollamaChatPanel.postMessage(panelKey, {
        type: "ollama.setConversation",
        model,
        sessionId,
        messages: session?.messages ?? []
      });
      if (session) {
        ollamaChatsByKey.set(ollamaChatKey(endpointId, model), session.messages);
      }
      return;
    }

    if (msg.type === "ollama.deleteSession") {
      const endpointId = String(msg.endpointId ?? "");
      const model = String(msg.model ?? "").trim();
      const sessionId = String(msg.sessionId ?? "").trim();
      if (!endpointId || !model || !sessionId) return;
      ollamaPendingSessionByPanelKey.delete(panelKey);
      const sessions = deps.sessionStore.listSessions(endpointId, model).filter((session) => session.id !== sessionId);
      await deps.sessionStore.saveSessions(endpointId, model, sessions);
      const nextSession = sessions[0];
      const nextMessages = nextSession?.messages ?? [];
      if (nextSession) {
        ollamaChatsByKey.set(ollamaChatKey(endpointId, model), nextMessages);
      } else {
        ollamaChatsByKey.delete(ollamaChatKey(endpointId, model));
      }
      deps.ollamaChatPanel.postMessage(panelKey, {
        type: "ollama.setSessions",
        sessionId: nextSession?.id,
        sessions: sessions.map((session) => ({ id: session.id, name: session.name, updatedAt: session.updatedAt }))
      });
      deps.ollamaChatPanel.postMessage(panelKey, {
        type: "ollama.setConversation",
        model,
        sessionId: nextSession?.id,
        messages: nextMessages
      });
      return;
    }

    if (msg.type === "ollama.clear") {
      const ctrl = ollamaAbortByPanelKey.get(panelKey);
      if (ctrl) ctrl.abort();
      const endpointId = String(msg.endpointId ?? "");
      const model = String(msg.model ?? "");
      const sessionId = String(msg.sessionId ?? "").trim();
      if (!endpointId || !model) return;
      ollamaChatsByKey.delete(ollamaChatKey(endpointId, model));
      if (sessionId) await deps.sessionStore.upsertSession(endpointId, model, sessionId, []);
      return;
    }

    if (msg.type === "ollama.switchModel") {
      const ctrl = ollamaAbortByPanelKey.get(panelKey);
      if (ctrl) ctrl.abort();
      ollamaPendingSessionByPanelKey.delete(panelKey);
      const endpointId = String(msg.endpointId ?? "");
      const model = String(msg.model ?? "").trim();
      if (!endpointId || !model) return;
      const endpoint = deps.ollamaStore.list().find((item) => item.id === endpointId);
      if (!endpoint) {
        deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.error", message: "Ollama endpoint not found." });
        return;
      }
      const messages = ollamaChatsByKey.get(ollamaChatKey(endpoint.id, model)) ?? [];
      const sessions = deps.sessionStore.listSessions(endpoint.id, model);
      const selectedSessionId = sessions[0]?.id;
      const sessionMessages = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId)?.messages ?? messages : messages;
      let models: string[] = [];
      let modelInfos: Record<string, OllamaModelInfo> = {};
      try {
        models = await fetchOllamaModels(endpoint);
      } catch {}
      try {
        modelInfos = await fetchOllamaModelInfoMap(endpoint);
        modelInfos[model] = await enrichOllamaModelContextLimit(endpoint, model, modelInfos[model]);
      } catch {}
      if (!models.includes(model)) models = [...models, model];
      deps.ollamaChatPanel.postMessage(panelKey, {
        type: "ollama.setConversation",
        model,
        sessionId: selectedSessionId,
        messages: sessionMessages,
        models,
        modelInfos
      });
      deps.ollamaChatPanel.postMessage(panelKey, {
        type: "ollama.setSessions",
        sessionId: selectedSessionId,
        sessions: sessions.map((session) => ({ id: session.id, name: session.name, updatedAt: session.updatedAt }))
      });
      return;
    }

    if (msg.type !== "ollama.send") return;

    const endpointId = String(msg.endpointId ?? "");
    const model = String(msg.model ?? "");
    const requestedSessionId = String(msg.sessionId ?? "").trim();
    const pendingSessionId = ollamaPendingSessionByPanelKey.get(panelKey);
    const sessionId = pendingSessionId || requestedSessionId || randomUUID();
    if (pendingSessionId) ollamaPendingSessionByPanelKey.delete(panelKey);
    const prompt = String(msg.prompt ?? "").trim();
    if (!endpointId || !model || !prompt) return;

    const endpoint = deps.ollamaStore.list().find((item) => item.id === endpointId);
    if (!endpoint) {
      deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.error", message: "Ollama endpoint not found." });
      return;
    }

    const key = ollamaChatKey(endpoint.id, model);
    const foundSession = deps.sessionStore.listSessions(endpoint.id, model).find((session) => session.id === sessionId);
    const previousFromSession = foundSession?.messages ?? [];
    const previous = foundSession ? previousFromSession : ollamaChatsByKey.get(key) ?? [];
    const requestMessages: OllamaChatMessage[] = [...previous, { role: "user", content: prompt }];
    ollamaChatsByKey.set(key, requestMessages.slice(-40));

    const existingCtrl = ollamaAbortByPanelKey.get(panelKey);
    if (existingCtrl) existingCtrl.abort();
    const ctrl = new AbortController();
    ollamaAbortByPanelKey.set(panelKey, ctrl);
    deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.streamStart" });

    try {
      const { content, finalChunk } = await streamOllamaChat(endpoint, { model, messages: requestMessages }, panelKey, ctrl.signal);
      const answer = String(content ?? "").trim();
      if (!answer) throw new Error("Empty response");
      const assistantMessage: OllamaChatMessage = {
        role: "assistant",
        content: answer,
        meta: ollamaMetaFromChatResponse(finalChunk ?? {})
      };
      const nextMessages: OllamaChatMessage[] = [...requestMessages, assistantMessage];
      ollamaChatsByKey.set(key, nextMessages.slice(-40));
      await deps.sessionStore.upsertSession(endpoint.id, model, sessionId, nextMessages.slice(-40));
      const sessions = deps.sessionStore.listSessions(endpoint.id, model);
      deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.streamDone", message: assistantMessage });
      deps.ollamaChatPanel.postMessage(panelKey, {
        type: "ollama.setSessions",
        sessionId,
        sessions: sessions.map((session) => ({ id: session.id, name: session.name, updatedAt: session.updatedAt }))
      });
    } catch (e) {
      const partialContent = String((e as { partialContent?: unknown }).partialContent ?? "").trim();
      const isAbort = ctrl.signal.aborted || (e as Error).name === "AbortError";
      if (isAbort) {
        if (partialContent) {
          const assistantMessage: OllamaChatMessage = { role: "assistant", content: partialContent };
          const nextMessages: OllamaChatMessage[] = [...requestMessages, assistantMessage];
          ollamaChatsByKey.set(key, nextMessages.slice(-40));
          await deps.sessionStore.upsertSession(endpoint.id, model, sessionId, nextMessages.slice(-40));
          deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.streamDone", message: assistantMessage, stopped: true });
        } else {
          await deps.sessionStore.upsertSession(endpoint.id, model, sessionId, requestMessages.slice(-40));
          deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.streamDone", stopped: true });
        }
      } else {
        deps.ollamaChatPanel.postMessage(panelKey, { type: "ollama.error", message: (e as Error).message });
      }
    } finally {
      if (ollamaAbortByPanelKey.get(panelKey) === ctrl) {
        ollamaAbortByPanelKey.delete(panelKey);
      }
    }
  }

  return {
    fetchOllamaJson,
    fetchOllamaModels,
    fetchOllamaModelInfoMap,
    enrichOllamaModelContextLimit,
    pullModel,
    deleteModel,
    pickOllamaEndpoint,
    pickOllamaModel,
    pickLlmProvider,
    showOllamaChat,
    handleOllamaChatPanelMessage
  };
}
