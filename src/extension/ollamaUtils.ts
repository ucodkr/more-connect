import type { LlmProvider, OllamaEndpoint } from "../types";
import type { OllamaChatMessage } from "../ui/ollamaChatPanel";

export type OllamaModelInfo = {
  name: string;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  contextLimit?: number;
  family?: string;
  format?: string;
};

export type OllamaSession = {
  id: string;
  name: string;
  endpointId: string;
  model: string;
  messages: OllamaChatMessage[];
  createdAt: number;
  updatedAt: number;
};

export function llmProviderOf(endpoint: OllamaEndpoint): LlmProvider {
  return endpoint.provider === "vllm" ? "vllm" : "ollama";
}

export function llmProviderLabel(endpoint: OllamaEndpoint): string {
  return llmProviderOf(endpoint) === "vllm" ? "vLLM" : "Ollama";
}

export function isOllamaProvider(endpoint: OllamaEndpoint): boolean {
  return llmProviderOf(endpoint) === "ollama";
}

export function parseContextLimitFromShow(payload: any): number | undefined {
  const obj = payload?.model_info;
  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    for (const [k, v] of entries) {
      const key = String(k).toLowerCase();
      if (
        key.includes("context_length") ||
        key.includes("num_ctx") ||
        key.includes("n_ctx") ||
        key.includes("max_position_embeddings")
      ) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return Math.trunc(n);
      }
    }
  }
  const parameters = String(payload?.parameters ?? "");
  const match = parameters.match(/\bnum_ctx\s+(\d+)\b/i);
  if (match?.[1]) return Number(match[1]);
  return;
}

export function toNumberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function toOllamaModelInfo(tag: any): OllamaModelInfo {
  return {
    name: String(tag?.name ?? ""),
    sizeBytes: toNumberOrUndefined(tag?.size),
    parameterSize: String(tag?.details?.parameter_size ?? "").trim() || undefined,
    quantization: String(tag?.details?.quantization_level ?? "").trim() || undefined,
    family: String(tag?.details?.family ?? "").trim() || undefined,
    format: String(tag?.details?.format ?? "").trim() || undefined
  };
}

export function ollamaChatKey(endpointId: string, model: string): string {
  return `${endpointId}::${model}`;
}

export function ollamaPanelKey(endpointId: string): string {
  return endpointId;
}

export function ollamaSessionScopeKey(endpointId: string, model: string): string {
  return `${endpointId}::${model}`;
}

export function buildOllamaSessionName(messages: OllamaChatMessage[], fallback: string): string {
  const firstUser = messages.find((message) => message.role === "user" && String(message.content ?? "").trim());
  if (!firstUser) return fallback;
  const title = String(firstUser.content ?? "").replaceAll(/\s+/g, " ").trim();
  return title.length > 40 ? `${title.slice(0, 40)}...` : title;
}

export function ollamaMetaFromChatResponse(result: any): OllamaChatMessage["meta"] {
  const usage = result?.usage;
  if (usage && typeof usage === "object") {
    const inputTokens = toNumberOrUndefined(usage?.prompt_tokens);
    const outputTokens = toNumberOrUndefined(usage?.completion_tokens);
    const totalMs = toNumberOrUndefined(result?.latency_ms);
    return { inputTokens, outputTokens, totalMs };
  }
  const inputTokens = toNumberOrUndefined(result?.prompt_eval_count);
  const outputTokens = toNumberOrUndefined(result?.eval_count);
  const totalDurationNs = toNumberOrUndefined(result?.total_duration);
  const evalDurationNs = toNumberOrUndefined(result?.eval_duration);
  const totalMs = totalDurationNs !== undefined ? totalDurationNs / 1_000_000 : undefined;
  const tokensPerSec =
    outputTokens !== undefined && evalDurationNs !== undefined && evalDurationNs > 0
      ? outputTokens / (evalDurationNs / 1_000_000_000)
      : undefined;
  return { inputTokens, outputTokens, totalMs, tokensPerSec };
}

type OllamaSessionStoreDeps = {
  globalState: vscode.Memento;
  sessionsKey: string;
};

import type * as vscode from "vscode";

export function createOllamaSessionStore(deps: OllamaSessionStoreDeps) {
  function listSessions(endpointId: string, model: string): OllamaSession[] {
    const all = deps.globalState.get<Record<string, OllamaSession[]>>(deps.sessionsKey, {});
    const key = ollamaSessionScopeKey(endpointId, model);
    const sessions = Array.isArray(all[key]) ? all[key] : [];
    return sessions.filter((session) => session.endpointId === endpointId && session.model === model).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function saveSessions(endpointId: string, model: string, sessions: OllamaSession[]): Promise<void> {
    const all = deps.globalState.get<Record<string, OllamaSession[]>>(deps.sessionsKey, {});
    const key = ollamaSessionScopeKey(endpointId, model);
    all[key] = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
    await deps.globalState.update(deps.sessionsKey, all);
  }

  async function upsertSession(
    endpointId: string,
    model: string,
    sessionId: string,
    messages: OllamaChatMessage[]
  ): Promise<OllamaSession> {
    const now = Date.now();
    const all = listSessions(endpointId, model);
    const idx = all.findIndex((session) => session.id === sessionId);
    if (idx >= 0) {
      const current = all[idx];
      const updated: OllamaSession = {
        ...current,
        messages,
        updatedAt: now,
        name: buildOllamaSessionName(messages, current.name)
      };
      all[idx] = updated;
      await saveSessions(endpointId, model, all);
      return updated;
    }
    const created: OllamaSession = {
      id: sessionId,
      endpointId,
      model,
      messages,
      createdAt: now,
      updatedAt: now,
      name: buildOllamaSessionName(messages, `Session ${new Date(now).toLocaleString()}`)
    };
    all.unshift(created);
    await saveSessions(endpointId, model, all);
    return created;
  }

  return { listSessions, saveSessions, upsertSession };
}
