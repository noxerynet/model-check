(() => {
  "use strict";

  const session = { name: "", baseUrl: "", apiKey: "", headers: {} };
  const models = new Map();
  const selected = new Set();
  let selectedModel = null;

  const $ = (id) => document.getElementById(id);
  const form = $("providerForm");
  const formError = $("formError");

  const savedTheme = (() => {
    try { return localStorage.getItem("model-check-theme"); } catch { return null; }
  })();
  if (savedTheme === "dark" || savedTheme === "light") document.documentElement.dataset.theme = savedTheme;
  $("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("model-check-theme", next); } catch { /* ignore */ }
  });

  $("addProviderBtn").addEventListener("click", () => {
    form.hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("clearBtn").addEventListener("click", () => {
    session.name = ""; session.baseUrl = ""; session.apiKey = ""; session.headers = {};
    models.clear(); selected.clear(); selectedModel = null;
    updateSelectedBtn();
    $("modelsBody").textContent = "";
    for (const id of ["summary", "modelsSection", "detailSection", "chatSection"]) $(id).hidden = true;
    $("clearBtn").hidden = true;
    $("baseUrl").value = ""; $("apiKey").value = "";
  });

  function showError(message) {
    formError.textContent = message;
    formError.hidden = false;
  }

  function parseHeaders(text) {
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data && data.error && data.error.message ? data.error.message : `Request failed (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  function statusPill(status) {
    if (!status) return '<span class="pill">unknown</span>';
    const label = status.replace(/_/g, " ");
    return `<span class="pill ${status}">${label}</span>`;
  }

  function identityPill(identity) {
    if (identity === "match") return '<span class="pill match">match</span>';
    if (identity === "mismatch") return '<span class="pill mismatch">mismatch</span>';
    if (identity === "unavailable") return '<span class="muted">unavailable</span>';
    return '<span class="muted">—</span>';
  }

  function renderModels() {
    const body = $("modelsBody");
    body.textContent = "";
    for (const m of models.values()) {
      const tr = document.createElement("tr");
      if (m.id === selectedModel) tr.className = "selected";
      const latency = m.latencyMs != null ? `${m.latencyMs} ms` : "—";
      tr.innerHTML =
        `<td class="check-col"></td>` +
        `<td><code></code></td>` +
        `<td></td><td></td><td></td>` +
        `<td></td>`;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(m.id);
      box.setAttribute("aria-label", `Select ${m.id}`);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(m.id);
        else selected.delete(m.id);
        updateSelectedBtn();
        syncSelectAll();
      });
      tr.children[0].appendChild(box);
      tr.children[1].firstChild.textContent = m.id;
      tr.children[2].innerHTML = statusPill(m.status);
      tr.children[3].innerHTML = identityPill(m.identity);
      tr.children[4].textContent = latency;
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.type = "button";
      btn.textContent = "Open";
      btn.addEventListener("click", () => selectModel(m.id));
      tr.children[5].appendChild(btn);
      body.appendChild(tr);
    }
    syncSelectAll();
  }

  function updateSelectedBtn() {
    const btn = $("runSelectedBtn");
    btn.textContent = selected.size > 0 ? `Test selected (${selected.size})` : "Test selected";
    btn.disabled = selected.size === 0;
  }

  function syncSelectAll() {
    $("selectAll").checked = models.size > 0 && selected.size === models.size;
  }

  $("selectAll").addEventListener("change", (e) => {
    selected.clear();
    if (e.target.checked) for (const id of models.keys()) selected.add(id);
    renderModels();
    updateSelectedBtn();
  });

  function updateSummary() {
    let working = 0, failed = 0, unknown = 0;
    for (const m of models.values()) {
      if (m.status === "working" || m.status === "verified") working++;
      else if (m.status == null || m.status === "unknown") unknown++;
      else failed++;
    }
    $("statModels").textContent = String(models.size);
    $("statWorking").textContent = String(working);
    $("statFailed").textContent = String(failed);
    $("statUnknown").textContent = String(unknown);
  }

  function selectModel(id) {
    selectedModel = id;
    const m = models.get(id);
    renderModels();
    $("detailSection").hidden = false;
    $("detailTitle").textContent = id;
    const created = m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : "n/a";
    $("detailMeta").textContent = `Owner: ${m.owned_by} · Created: ${created}`;
    $("suiteResults").textContent = "";
    $("chatSection").hidden = true;
    $("detailSection").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function basePayload() {
    return { baseUrl: session.baseUrl, apiKey: session.apiKey, headers: session.headers };
  }

  $("providerInputs").addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.hidden = true;
    let headers = {};
    try {
      headers = parseHeaders($("customHeaders").value);
    } catch {
      showError("Custom headers must be a JSON object.");
      return;
    }
    const btn = $("connectBtn");
    btn.disabled = true;
    try {
      const data = await api("/api/providers/models", {
        baseUrl: $("baseUrl").value.trim(),
        apiKey: $("apiKey").value,
        headers,
      });
      session.name = $("providerName").value.trim() || "Provider";
      session.baseUrl = $("baseUrl").value.trim().replace(/\/+$/, "");
      session.apiKey = $("apiKey").value;
      session.headers = headers;
      models.clear();
      selected.clear();
      updateSelectedBtn();
      for (const m of data.models) {
        models.set(m.id, { ...m, status: null, identity: null, latencyMs: null });
      }
      selectedModel = null;
      $("summaryTitle").textContent = session.name;
      $("statEndpoint").textContent = data.endpoint;
      $("summaryNote").textContent = `Listed in ${data.latencyMs} ms via GET /models.`;
      $("summary").hidden = false;
      $("modelsSection").hidden = false;
      $("detailSection").hidden = true;
      $("chatSection").hidden = true;
      $("clearBtn").hidden = false;
      renderModels();
      updateSummary();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      btn.disabled = false;
    }
  });

  async function quickCheck(id) {
    const m = models.get(id);
    if (!m) return;
    try {
      const data = await api("/api/models/test", { ...basePayload(), model: id, tests: ["basic"] });
      const r = data.results[0];
      m.status = r ? r.status : "unknown";
      m.identity = r ? r.identity : "unavailable";
      m.latencyMs = r ? r.latencyMs : null;
    } catch {
      m.status = "failed";
    }
    renderModels();
    updateSummary();
  }

  $("runSelectedBtn").addEventListener("click", async () => {
    const btn = $("runSelectedBtn");
    btn.disabled = true;
    try {
      for (const id of [...selected]) {
        if (!models.has(id)) selected.delete(id);
        else await quickCheck(id);
      }
    } finally {
      updateSelectedBtn();
    }
  });

  $("runAllBtn").addEventListener("click", async () => {
    const btn = $("runAllBtn");
    btn.disabled = true;
    try {
      for (const m of models.values()) await quickCheck(m.id);
    } finally {
      btn.disabled = false;
    }
  });

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  $("suiteBtn").addEventListener("click", async () => {
    if (!selectedModel) return;
    const btn = $("suiteBtn");
    btn.disabled = true;
    const box = $("suiteResults");
    box.innerHTML = '<p class="muted">Running tests…</p>';
    try {
      const data = await api("/api/models/test", { ...basePayload(), model: selectedModel });
      const m = models.get(selectedModel);
      if (m && data.results.length > 0) {
        const first = data.results[0];
        m.status = first.status;
        m.identity = first.identity;
        m.latencyMs = first.latencyMs;
        renderModels();
        updateSummary();
      }
      box.textContent = "";
      for (const r of data.results) {
        const div = document.createElement("div");
        div.className = "test";
        div.innerHTML =
          `<div class="test-head"><span class="test-name"></span> ` +
          `<span class="pill ${r.status}">${r.status.replace(/_/g, " ")}</span> ` +
          `<span class="test-meta"></span></div>` +
          (r.error ? `<p class="error"></p>` : "") +
          (r.response ? `<pre class="response"></pre>` : "");
        div.querySelector(".test-name").textContent = r.name;
        div.querySelector(".test-meta").textContent =
          `HTTP ${r.httpStatus ?? "—"} · ${r.latencyMs} ms · identity: ${r.identity}` +
          (r.returnedModel ? ` · returned: ${r.returnedModel}` : "");
        if (r.error) div.querySelector(".error").textContent = r.error;
        if (r.response) div.querySelector("pre").textContent = r.response;
        box.appendChild(div);
      }
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent =
        "Identity compares the requested model ID with the model field in the API response. " +
        "A model never proves its identity by what it says about itself.";
      box.appendChild(note);
    } catch (err) {
      box.innerHTML = `<p class="error">${escapeHtml(err instanceof Error ? err.message : "Test failed.")}</p>`;
    } finally {
      btn.disabled = false;
    }
  });

  $("chatOpenBtn").addEventListener("click", () => {
    if (!selectedModel) return;
    $("chatSection").hidden = false;
    $("chatModelLabel").textContent = `— ${selectedModel}`;
    $("chatMeta").textContent = `Provider: ${session.name} · ${session.baseUrl} · model: ${selectedModel}`;
    $("chatSection").scrollIntoView({ behavior: "smooth", block: "start" });
    $("chatInput").focus();
  });

  const history = [];
  $("chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("chatInput").value.trim();
    if (!input || !selectedModel) return;
    $("chatInput").value = "";
    $("chatError").hidden = true;
    history.push({ role: "user", content: input });
    appendMsg("You", input);
    const bubble = appendMsg("Assistant", "…");
    const started = Date.now();
    try {
      const res = await fetch("/api/models/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload(), model: selectedModel, messages: history, stream: true }),
      });
      if (!res.ok || res.body == null) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error && data.error.message ? data.error.message : `Chat failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const event = JSON.parse(line.slice(5).trim());
          if (event.delta) {
            text += event.delta;
            bubble.textContent = text;
          } else if (event.error) {
            throw new Error(event.error);
          } else if (event.done) {
            const ms = Date.now() - started;
            bubble.textContent = text;
            history.push({ role: "assistant", content: text });
            $("chatMeta").textContent =
              `Provider: ${session.name} · ${session.baseUrl} · model: ${event.model ?? selectedModel} · ${ms} ms`;
          }
        }
      }
      if (!text) bubble.textContent = "(empty response)";
      else history.push({ role: "assistant", content: text });
    } catch (err) {
      bubble.textContent = "(failed)";
      const el = $("chatError");
      el.textContent = err instanceof Error ? err.message : "Chat failed.";
      el.hidden = false;
    }
  });

  function appendMsg(who, text) {
    const log = $("chatLog");
    const div = document.createElement("div");
    div.className = "msg";
    const w = document.createElement("div");
    w.className = "who";
    w.textContent = who;
    const t = document.createElement("div");
    t.className = "text";
    t.textContent = text;
    div.appendChild(w);
    div.appendChild(t);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return t;
  }
})();
