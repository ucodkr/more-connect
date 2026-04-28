(function () {
  const vscode = acquireVsCodeApi();
  let state = { endpointId: "", endpointName: "", endpointUrl: "", model: "", models: [], modelInfos: {}, messages: [] };
  try {
    const stateEl = document.getElementById("mcState");
    const b64 = stateEl ? String(stateEl.textContent || "") : "";
    const binary = atob(b64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder("utf-8").decode(bytes);
    state = JSON.parse(json);
  } catch (e) {
    document.body.innerHTML =
      "<pre style='padding:12px;color:var(--vscode-errorForeground)'>Failed to parse initial state: " +
      String((e && e.message) || e) +
      "</pre>";
    return;
  }

  const messagesEl = document.getElementById("messages");
  const promptEl = document.getElementById("prompt");
  const statusEl = document.getElementById("status");
  const modelSelectEl = document.getElementById("modelSelect");
  const sessionSelectEl = document.getElementById("sessionSelect");
  const newSessionBtn = document.getElementById("newSessionBtn");
  const deleteSessionBtn = document.getElementById("deleteSessionBtn");
  const modelInfoEl = document.getElementById("modelInfo");
  const sendBtn = document.getElementById("sendBtn");
  const stopBtn = document.getElementById("stopBtn");
  const clearBtn = document.getElementById("clearBtn");
  let sending = false;
  let composing = false;
  let streamAssistantIndex = -1;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatMs(ms) {
    const n = Number(ms || 0);
    if (!Number.isFinite(n)) return "-";
    if (n >= 1000) return (n / 1000).toFixed(2) + "s";
    return Math.round(n) + "ms";
  }

  function humanBytes(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return v.toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function renderInlineMarkdown(text) {
    return escapeHtml(String(text || ""))
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function renderTable(lines) {
    const rows = lines.map(function (line) {
      return line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map(function (cell) {
          return renderInlineMarkdown(cell.trim());
        });
    });
    if (rows.length < 2) return "";
    const header = rows[0] || [];
    const body = rows.slice(2);
    return (
      "<table><thead><tr>" +
      header.map(function (h) { return "<th>" + h + "</th>"; }).join("") +
      "</tr></thead><tbody>" +
      body
        .map(function (r) {
          return "<tr>" + r.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>";
        })
        .join("") +
      "</tbody></table>"
    );
  }

  function renderMarkdown(input) {
    const lines = String(input || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    const fence = String.fromCharCode(96, 96, 96);

    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith(fence)) {
        i++;
        const code = [];
        while (i < lines.length && !lines[i].startsWith(fence)) {
          code.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        out.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
        continue;
      }

      if (
        i + 1 < lines.length &&
        /^\s*\|.*\|\s*$/.test(lines[i]) &&
        /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        const t = [lines[i], lines[i + 1]];
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          t.push(lines[i]);
          i++;
        }
        out.push(renderTable(t));
        continue;
      }

      const h = line.match(/^\s*(#{1,3})\s+(.+)$/);
      if (h) {
        const level = h[1].length;
        out.push("<h" + level + ">" + renderInlineMarkdown(h[2]) + "</h" + level + ">");
        i++;
        continue;
      }

      if (/^\s*>\s+/.test(line)) {
        out.push("<blockquote>" + renderInlineMarkdown(line.replace(/^\s*>\s+/, "")) + "</blockquote>");
        i++;
        continue;
      }

      if (/^\s*-\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
          items.push("<li>" + renderInlineMarkdown(lines[i].replace(/^\s*-\s+/, "")) + "</li>");
          i++;
        }
        out.push("<ul>" + items.join("") + "</ul>");
        continue;
      }

      if (!line.trim()) {
        i++;
        continue;
      }

      const p = [];
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith(fence)) {
        if (/^\s*(#{1,3})\s+/.test(lines[i])) break;
        if (/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?/.test(lines[i + 1])) break;
        if (/^\s*-\s+/.test(lines[i])) break;
        if (/^\s*>\s+/.test(lines[i])) break;
        p.push(lines[i]);
        i++;
      }
      out.push("<p>" + renderInlineMarkdown(p.join("\n")).replace(/\n/g, "<br/>") + "</p>");
    }

    return out.join("");
  }

  function stripThinkForDisplay(input) {
    const raw = String(input || "");
    const lower = raw.toLowerCase();
    let out = "";
    let i = 0;
    let inThink = false;
    let hasOpenThink = false;

    while (i < raw.length) {
      if (!inThink) {
        const openIdx = lower.indexOf("<think>", i);
        const strayCloseIdx = lower.indexOf("</think>", i);
        let nextIdx = -1;
        let token = "";
        if (openIdx >= 0 && (strayCloseIdx < 0 || openIdx <= strayCloseIdx)) {
          nextIdx = openIdx;
          token = "<think>";
        } else if (strayCloseIdx >= 0) {
          nextIdx = strayCloseIdx;
          token = "</think>";
        }
        if (nextIdx < 0) {
          out += raw.slice(i);
          break;
        }
        out += raw.slice(i, nextIdx);
        i = nextIdx + token.length;
        if (token === "<think>") {
          inThink = true;
          hasOpenThink = true;
        }
      } else {
        const closeIdx = lower.indexOf("</think>", i);
        if (closeIdx < 0) {
          i = raw.length;
          break;
        }
        i = closeIdx + "</think>".length;
        inThink = false;
      }
    }

    const visible = out.trim();
    if (inThink || (hasOpenThink && !visible)) {
      return visible ? visible + "\n\nThinking..." : "Thinking...";
    }
    return out.trimEnd();
  }

  function renderModelInfo() {
    const model = String(state.model || "");
    const info = state.modelInfos && typeof state.modelInfos === "object" ? state.modelInfos[model] : undefined;
    const size = info && Number.isFinite(info.sizeBytes) ? humanBytes(Number(info.sizeBytes)) : "-";
    const ctx = info && Number.isFinite(info.contextLimit) ? Number(info.contextLimit).toLocaleString() : "-";
    const params = String((info && info.parameterSize) || "-");
    const quant = String((info && info.quantization) || "-");
    const family = String((info && info.family) || "-");
    const format = String((info && info.format) || "-");
    const modelCount = Array.isArray(state.models) ? state.models.length : 0;
    modelInfoEl.textContent =
      "models: " + String(modelCount) +
      " · family: " + family +
      " · format: " + format +
      " · context: " + ctx +
      " · size: " + size +
      " · params: " + params +
      " · quant: " + quant;
  }

  function renderModelOptions() {
    let current = String(state.model || "");
    const set = new Set(Array.isArray(state.models) ? state.models : []);
    if (current) set.add(current);
    const all = Array.from(set.values()).sort();
    if (!current && all.length > 0) {
      current = String(all[0]);
      state.model = current;
    }
    while (modelSelectEl.firstChild) modelSelectEl.removeChild(modelSelectEl.firstChild);
    if (all.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no models)";
      opt.disabled = true;
      opt.selected = true;
      modelSelectEl.appendChild(opt);
    } else {
      all.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = String(m);
        opt.textContent = String(m);
        opt.selected = String(m) === current;
        modelSelectEl.appendChild(opt);
      });
    }
    renderModelInfo();
  }

  function renderSessions() {
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const currentId = String(state.sessionId || "");
    while (sessionSelectEl.firstChild) sessionSelectEl.removeChild(sessionSelectEl.firstChild);
    if (sessions.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no sessions)";
      opt.disabled = true;
      opt.selected = true;
      sessionSelectEl.appendChild(opt);
      return;
    }
    sessions.forEach(function (s) {
      const opt = document.createElement("option");
      opt.value = String(s.id);
      opt.textContent = String(s.name || "Session");
      opt.selected = String(s.id) === currentId;
      sessionSelectEl.appendChild(opt);
    });
  }

  function renderMessages() {
    messagesEl.innerHTML = (state.messages || [])
      .map((m) => {
        const meta = m && typeof m === "object" ? m.meta : undefined;
        const parts = [];
        if (meta && Number.isFinite(meta.inputTokens)) parts.push("in: " + String(meta.inputTokens));
        if (meta && Number.isFinite(meta.outputTokens)) parts.push("out: " + String(meta.outputTokens));
        if (meta && Number.isFinite(meta.totalMs)) parts.push("time: " + formatMs(meta.totalMs));
        if (meta && Number.isFinite(meta.tokensPerSec)) parts.push("t/s: " + Number(meta.tokensPerSec).toFixed(1));
        const metaHtml = parts.length > 0 ? '<div class="meta">' + escapeHtml(parts.join(" · ")) + "</div>" : "";
        const role = String(m.role || "assistant");
        const raw = String(m.content || "");
        const displayRaw = role === "assistant" ? stripThinkForDisplay(raw) : raw;
        const contentHtml =
          role === "assistant" || role === "system"
            ? renderMarkdown(displayRaw)
            : escapeHtml(displayRaw).replace(/\n/g, "<br/>");
        return '<div class="msg ' + role + '"><div class="content">' + contentHtml + "</div>" + metaHtml + "</div>";
      })
      .join("");
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setStatus(text, isError, typing) {
    statusEl.classList.toggle("error", Boolean(isError));
    statusEl.classList.toggle("typing", Boolean(typing));
    if (typing) {
      statusEl.innerHTML = 'Generating response<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
      return;
    }
    statusEl.textContent = String(text || "");
  }

  function setSending(v) {
    sending = v;
    sendBtn.disabled = v;
    stopBtn.disabled = !v;
    modelSelectEl.disabled = v;
    sessionSelectEl.disabled = v;
    newSessionBtn.disabled = v;
    deleteSessionBtn.disabled = v;
  }

  function sendPrompt() {
    if (composing) return;
    const prompt = String(promptEl.value || "").trim();
    if (!prompt || sending) return;
    state.messages.push({ role: "user", content: prompt });
    renderMessages();
    promptEl.value = "";
    setSending(true);
    setStatus("", false, true);
    streamAssistantIndex = -1;
    vscode.postMessage({
      type: "ollama.send",
      endpointId: state.endpointId,
      model: state.model,
      sessionId: state.sessionId,
      prompt: prompt
    });
  }

  sendBtn.addEventListener("click", sendPrompt);
  newSessionBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "ollama.createSession", endpointId: state.endpointId, model: state.model });
  });
  deleteSessionBtn.addEventListener("click", function () {
    const sessionId = String(state.sessionId || "").trim();
    if (!sessionId) return;
    vscode.postMessage({
      type: "ollama.deleteSession",
      endpointId: state.endpointId,
      model: state.model,
      sessionId: sessionId
    });
  });
  stopBtn.addEventListener("click", function () {
    if (!sending) return;
    vscode.postMessage({ type: "ollama.stop", endpointId: state.endpointId, model: state.model });
  });
  promptEl.addEventListener("compositionstart", function () {
    composing = true;
  });
  promptEl.addEventListener("compositionend", function () {
    composing = false;
  });
  promptEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !composing && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendPrompt();
    }
  });
  clearBtn.addEventListener("click", function () {
    state.messages = [];
    streamAssistantIndex = -1;
    renderMessages();
    setStatus("");
    vscode.postMessage({ type: "ollama.clear", endpointId: state.endpointId, model: state.model, sessionId: state.sessionId });
  });
  modelSelectEl.addEventListener("change", function () {
    const model = String(modelSelectEl.value || "").trim();
    if (!model || model === state.model) return;
    state.model = model;
    state.messages = [];
    streamAssistantIndex = -1;
    renderMessages();
    renderModelOptions();
    setStatus("Loading conversation...");
    vscode.postMessage({ type: "ollama.switchModel", endpointId: state.endpointId, model: model });
    vscode.postMessage({ type: "ollama.listSessions", endpointId: state.endpointId, model: model });
  });
  sessionSelectEl.addEventListener("change", function () {
    const sessionId = String(sessionSelectEl.value || "").trim();
    if (!sessionId || sessionId === String(state.sessionId || "")) return;
    state.sessionId = sessionId;
    setStatus("Loading session...");
    vscode.postMessage({
      type: "ollama.selectSession",
      endpointId: state.endpointId,
      model: state.model,
      sessionId: sessionId
    });
  });

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ollama.streamStart") {
      state.messages.push({ role: "assistant", content: "" });
      streamAssistantIndex = state.messages.length - 1;
      renderMessages();
      setSending(true);
      setStatus("", false, true);
      return;
    }
    if (msg.type === "ollama.streamDelta") {
      const delta = String(msg.delta || "");
      if (!delta) return;
      if (streamAssistantIndex < 0 || !state.messages[streamAssistantIndex]) {
        state.messages.push({ role: "assistant", content: delta });
        streamAssistantIndex = state.messages.length - 1;
      } else {
        state.messages[streamAssistantIndex].content = String(state.messages[streamAssistantIndex].content || "") + delta;
      }
      renderMessages();
      return;
    }
    if (msg.type === "ollama.streamDone") {
      if (msg.message && typeof msg.message === "object") {
        if (streamAssistantIndex >= 0 && state.messages[streamAssistantIndex]) state.messages[streamAssistantIndex] = msg.message;
        else state.messages.push(msg.message);
      } else if (streamAssistantIndex >= 0 && !String((state.messages[streamAssistantIndex] && state.messages[streamAssistantIndex].content) || "").trim()) {
        state.messages.splice(streamAssistantIndex, 1);
      }
      streamAssistantIndex = -1;
      renderMessages();
      setSending(false);
      setStatus(msg.stopped ? "Stopped" : "");
      return;
    }
    if (msg.type === "ollama.error") {
      if (streamAssistantIndex >= 0 && !String((state.messages[streamAssistantIndex] && state.messages[streamAssistantIndex].content) || "").trim()) {
        state.messages.splice(streamAssistantIndex, 1);
        renderMessages();
      }
      streamAssistantIndex = -1;
      setSending(false);
      setStatus(String(msg.message || "Request failed"), true);
      return;
    }
    if (msg.type === "ollama.setConversation") {
      state.model = String(msg.model || state.model);
      state.sessionId = String(msg.sessionId || state.sessionId || "");
      state.messages = Array.isArray(msg.messages) ? msg.messages : [];
      if (Array.isArray(msg.models)) state.models = msg.models;
      if (msg.modelInfos && typeof msg.modelInfos === "object") state.modelInfos = msg.modelInfos;
      renderModelOptions();
      renderSessions();
      renderMessages();
      setSending(false);
      setStatus("");
      return;
    }
    if (msg.type === "ollama.setModels") {
      state.models = Array.isArray(msg.models) ? msg.models : [];
      if (msg.modelInfos && typeof msg.modelInfos === "object") state.modelInfos = msg.modelInfos;
      if (state.model && state.models.indexOf(state.model) < 0) state.models.push(state.model);
      renderModelOptions();
      return;
    }
    if (msg.type === "ollama.setSessions") {
      state.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      state.sessionId = String(msg.sessionId || state.sessionId || "");
      renderSessions();
      deleteSessionBtn.disabled = !state.sessionId;
      return;
    }
  });

  vscode.postMessage({ type: "ollama.listModels", endpointId: state.endpointId, model: state.model });
  vscode.postMessage({ type: "ollama.listSessions", endpointId: state.endpointId, model: state.model });
  renderModelOptions();
  renderSessions();
  renderMessages();
  deleteSessionBtn.disabled = !state.sessionId;
  promptEl.focus();
})();
