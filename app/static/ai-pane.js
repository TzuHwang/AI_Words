"use strict";

// The AI assistant pane, shared by the rich-text editor (/editor) and the LaTeX
// editor (/latex).
//
// The pane used to be written out in each page's HTML and driven by a copy of
// the same code in app.js and latex.js. The two drifted: /latex ended up with no
// conversation tabs, no slash commands, no skills or model panel, and a messages
// list that never became visible because it was missing the wrapper the CSS
// expects. So the markup lives here now — a page supplies an empty
// <section id="ai-pane"> and this fills it, along with the skills and model
// dialogs it appends to <body>. There is one copy of the pane, so there is
// nothing left to drift.
//
// What genuinely differs between the two editors is passed to init():
// where the document text comes from, and what "apply this document" means.
//
// Depends on ui.js ($, escapeHtml, uiAlert, uiConfirm).

const AiPane = (() => {
  // The neural-net glyph on the manage-models button.
  const MODELS_ICON = `
    <svg class="nn-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <g class="nn-edges" stroke="currentColor" stroke-width="1" opacity="0.5">
        <line x1="5" y1="5" x2="12" y2="9"/><line x1="5" y1="5" x2="12" y2="15"/>
        <line x1="5" y1="12" x2="12" y2="9"/><line x1="5" y1="12" x2="12" y2="15"/>
        <line x1="5" y1="19" x2="12" y2="9"/><line x1="5" y1="19" x2="12" y2="15"/>
        <line x1="12" y1="9" x2="19" y2="12"/><line x1="12" y1="15" x2="19" y2="12"/>
      </g>
      <g class="nn-nodes" fill="currentColor">
        <circle cx="5" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="5" cy="19" r="2"/>
        <circle cx="12" cy="9" r="2"/><circle cx="12" cy="15" r="2"/>
        <circle cx="19" cy="12" r="2"/>
      </g>
    </svg>`;

  const PANE_HTML = (placeholder) => `
    <header class="pane-header ai-header">
      <button data-act="toggle-ai" title="Collapse panel" class="icon-btn">⟩⟩</button>
      <span class="ai-title">AI Assistant</span>
      <select id="model-select" title="Active model"></select>
      <button data-act="add-model" title="Manage models" class="icon-btn"
              aria-label="Manage models">${MODELS_ICON}</button>
      <button data-act="skills" title="Skills" class="icon-btn">🧩</button>
    </header>

    <div class="ai-tabs">
      <div class="tab-list" id="tab-list"></div>
      <button id="tab-add" class="tab-add" title="New conversation">＋</button>
    </div>

    <!-- One messages panel per conversation is injected here -->
    <div id="tab-panels"></div>

    <div id="composer">
      <textarea id="chat-input" rows="1"></textarea>
      <button id="send-btn" title="Send">➤</button>
      <button id="stop-btn" title="Stop generating" hidden>■</button>
    </div>`;

  const MODALS_HTML = `
    <div id="skills-modal" class="modal" hidden>
      <div class="modal-box">
        <div class="modal-head">
          <h3>Skills</h3>
          <button data-act="close-skills" class="icon-btn">✕</button>
        </div>
        <p class="hint">Loaded skills are injected into the assistant's instructions.</p>
        <ul id="skills-list"></ul>
        <div class="skill-new">
          <input id="skill-name" placeholder="New skill name">
          <textarea id="skill-body" rows="4" placeholder="Skill instructions…"></textarea>
          <button data-act="create-skill">Create skill</button>
        </div>
      </div>
    </div>

    <div id="model-modal" class="modal" hidden>
      <div class="modal-box">
        <div class="modal-head">
          <h3>Models</h3>
          <button data-act="close-model" class="icon-btn">✕</button>
        </div>

        <ul id="model-list"></ul>

        <h4 class="mf-heading">Add a model</h4>
        <p class="hint">Connect a Claude (Anthropic) model, a hosted OpenAI-compatible
          endpoint, or a local server such as Ollama / LM Studio.</p>

        <div class="model-form">
          <label class="mf-row">
            <span>API type</span>
            <select id="mf-api-type">
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </label>

          <label class="mf-row">
            <span>Provider</span>
            <input id="mf-provider" placeholder="e.g. Qwen, Ollama, DeepSeek">
          </label>

          <label class="mf-row">
            <span>Display name</span>
            <input id="mf-label" placeholder="e.g. Claude Opus 4.8 (API)">
          </label>

          <label class="mf-row">
            <span>Model ID</span>
            <input id="mf-model" placeholder="e.g. claude-opus-4-8">
          </label>

          <label class="mf-row" id="mf-baseurl-row">
            <span>API endpoint</span>
            <input id="mf-base-url" placeholder="https://api.openai.com/v1">
          </label>

          <label class="mf-row">
            <span>API key</span>
            <input id="mf-api-key" type="password" placeholder="Paste a key, or use an env var below">
          </label>

          <label class="mf-row">
            <span>…or key env var</span>
            <input id="mf-api-key-env" placeholder="e.g. ANTHROPIC_API_KEY">
          </label>

          <details class="mf-adv">
            <summary>Advanced</summary>
            <label class="mf-row">
              <span>Internal ID</span>
              <input id="mf-id" placeholder="auto from name if left blank">
            </label>
          </details>

          <p class="hint" id="mf-error" hidden></p>
          <button data-act="create-model" id="mf-submit">Add model</button>
        </div>
      </div>
    </div>`;

  let hooks = {};
  let aiPane, divider, tabListEl, panelsEl, chatInput, sendBtn, stopBtn, modelSelect;
  let streaming = false;
  let streamAbort = null;   // AbortController for the in-flight chat request

  // -------------------------------------------------------------------------
  // Markdown (safe: escapes HTML first)
  // -------------------------------------------------------------------------
  function renderMarkdown(text) {
    if (!text) return "";
    let html = escapeHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code>${code}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    return html;
  }

  // Remove <think>...</think> reasoning emitted by local reasoning models.
  function stripThinking(text) {
    let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
    const open = t.lastIndexOf("<think>");
    if (open !== -1 && t.indexOf("</think>", open) === -1) t = t.slice(0, open);
    const close = t.indexOf("</think>");
    if (close !== -1 && t.lastIndexOf("<think>", close) === -1) {
      t = t.slice(close + "</think>".length);
    }
    return t.trim();
  }

  // Extract a ```ai_words:document ... ``` block from assistant text.
  function stripDocBlock(text) {
    text = stripThinking(text);
    const re = /```ai_words:document\s*\n([\s\S]*?)```/;
    const m = text.match(re);
    if (!m) return { text, doc: null };
    return { text: text.replace(re, "").trim(), doc: m[1].trim() };
  }

  // -------------------------------------------------------------------------
  // Conversation tabs (multiple independent AI chats)
  // -------------------------------------------------------------------------
  let sessions = [];   // { id, title, autoTitle, history: [], el: <div.messages> }
  let activeId = null;
  let seq = 0;

  const activeSession = () => sessions.find((s) => s.id === activeId);
  const activeMessagesEl = () => activeSession()?.el;

  function createSession(activate = true) {
    const id = ++seq;
    const el = document.createElement("div");
    el.className = "messages";
    el.dataset.session = String(id);
    panelsEl.appendChild(el);
    const session = { id, title: `Chat ${id}`, autoTitle: true, history: [], el };
    sessions.push(session);
    renderTabs();
    if (activate) setActive(id);
    return session;
  }

  function setActive(id) {
    activeId = id;
    sessions.forEach((s) => s.el.classList.toggle("active", s.id === id));
    renderTabs();
    chatInput.focus();
  }

  function closeSession(id) {
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    sessions[idx].el.remove();
    sessions.splice(idx, 1);
    if (!sessions.length) { createSession(); return; }
    if (activeId === id) setActive(sessions[Math.max(0, idx - 1)].id);
    else renderTabs();
  }

  function renderTabs() {
    tabListEl.innerHTML = "";
    sessions.forEach((s) => {
      const tab = document.createElement("div");
      tab.className = "tab" + (s.id === activeId ? " active" : "");
      tab.innerHTML = `<span class="tab-title"></span><button class="tab-close" title="Close">✕</button>`;
      tab.querySelector(".tab-title").textContent = s.title;
      tab.title = s.title;
      tab.addEventListener("click", (e) => {
        if (e.target.closest(".tab-close")) return;
        setActive(s.id);
      });
      tab.querySelector(".tab-close").addEventListener("click", (e) => {
        e.stopPropagation();
        closeSession(s.id);
      });
      tabListEl.appendChild(tab);
    });
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------
  function addMessage(role, content, target = activeMessagesEl()) {
    const msg = document.createElement("div");
    msg.className = "msg " + role;
    const label = role === "user" ? "You" : role === "assistant" ? "Assistant" : "";
    msg.innerHTML = `${label ? `<span class="role">${label}</span>` : ""}<div class="bubble"></div>`;
    const bubble = msg.querySelector(".bubble");
    bubble.innerHTML = renderMarkdown(content);
    target.appendChild(msg);
    target.scrollTop = target.scrollHeight;
    return { msg, bubble };
  }

  function addSystemMessage(text, target = activeMessagesEl()) {
    const msg = document.createElement("div");
    msg.className = "msg system";
    msg.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    target.appendChild(msg);
    target.scrollTop = target.scrollHeight;
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------
  function fmtSecs(ms) {
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }

  async function send() {
    const text = chatInput.value.trim();
    if (!text || streaming) return;
    chatInput.value = "";
    chatInput.style.height = "auto";

    if (text.startsWith("/")) { await handleCommand(text); return; }

    const session = activeSession();
    addMessage("user", text);
    session.history.push({ role: "user", content: text });
    if (session.autoTitle) {
      session.title = text.length > 22 ? text.slice(0, 22) + "…" : text;
      session.autoTitle = false;
      renderTabs();
    }
    await streamAssistant(session);
  }

  async function streamAssistant(session) {
    streaming = true;
    streamAbort = new AbortController();
    sendBtn.hidden = true;
    stopBtn.hidden = false;
    const { bubble, msg } = addMessage("assistant", "", session.el);
    let full = "";

    const start = performance.now();
    const state = { hadThinking: false, reasonedMs: 0, firstAnswer: false };

    const render = () => {
      const { text } = stripDocBlock(full);
      const hasAnswer = text.length > 0;
      if (!hasAnswer && (/<think>/i.test(full) || full.trim())) state.hadThinking = true;
      if (hasAnswer && !state.firstAnswer) {
        state.firstAnswer = true;
        state.reasonedMs = performance.now() - start;
      }
      let head = "";
      if (!hasAnswer) {
        head = `<div class="reasoning"><span class="spin"></span>` +
          `Reasoning… <b>${fmtSecs(performance.now() - start)}</b></div>`;
      } else if (state.hadThinking || state.reasonedMs > 1500) {
        head = `<div class="reasoned">💭 Reasoned for ${fmtSecs(state.reasonedMs)}</div>`;
      }
      bubble.innerHTML = head + renderMarkdown(text);
      session.el.scrollTop = session.el.scrollHeight;
    };

    render();
    const ticker = setInterval(render, 250);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: session.history,
          document_html: hooks.getDocument(),
          selection_text: hooks.getSelection?.(),
          mode: hooks.mode,
        }),
        signal: streamAbort.signal,
      });
      if (!res.ok) throw new Error(res.statusText);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop();
        for (const block of lines) {
          const line = block.trim();
          if (!line.startsWith("data:")) continue;
          const payload = JSON.parse(line.slice(5).trim());
          if (payload.error) throw new Error(payload.error);
          if (payload.delta) {
            full += payload.delta;
            render();
          }
        }
      }
      clearInterval(ticker);
      session.history.push({ role: "assistant", content: full });
      finalizeAssistant(msg, bubble, full, state);
    } catch (err) {
      clearInterval(ticker);
      if (err.name === "AbortError") {
        // Stopped by the user — keep whatever streamed so far.
        if (full.trim()) {
          session.history.push({ role: "assistant", content: full });
          finalizeAssistant(msg, bubble, full, state);
        } else {
          bubble.innerHTML = `<span style="color:var(--text-dim)">Stopped.</span>`;
        }
      } else {
        bubble.innerHTML = `<span style="color:var(--accent)">Error: ${escapeHtml(err.message)}</span>`;
      }
    } finally {
      streaming = false;
      streamAbort = null;
      sendBtn.hidden = false;
      stopBtn.hidden = true;
      session.el.scrollTop = session.el.scrollHeight;
    }
  }

  // An ai_words:document block holds a full revised document. Offer to apply it.
  function finalizeAssistant(msg, bubble, full, state = {}) {
    const { text, doc } = stripDocBlock(full);
    const head = state.hadThinking || (state.reasonedMs || 0) > 1500
      ? `<div class="reasoned">💭 Reasoned for ${fmtSecs(state.reasonedMs || 0)}</div>`
      : "";
    bubble.innerHTML = head + renderMarkdown(text);
    if (doc != null) reviewProposal(msg, doc);
  }

  // -------------------------------------------------------------------------
  // Reviewing a proposal, one changed block at a time
  // -------------------------------------------------------------------------
  // The model always sends the whole document back, and the pane used to show
  // the whole thing — which is no way to judge a two-word fix buried in ten
  // paragraphs. So the proposal is diffed against what is in the editor now,
  // and only the blocks that actually changed are shown, one at a time: accept
  // or skip this one, then the next appears. Nothing reaches the document until
  // every change has been answered.
  //
  // What a "block" is differs per editor (an HTML element vs. a LaTeX
  // paragraph), so splitting and rejoining come from the page via
  // hooks.proposal.

  // Blocks are matched on their text with runs of whitespace flattened, so a
  // model that echoes an untouched paragraph with different indentation is not
  // read as having rewritten it.
  const blockKey = (s) => s.replace(/\s+/g, " ").trim();

  // The indices at which two block lists agree — a longest common subsequence,
  // which is what makes everything between two agreements a changed region.
  function commonPairs(a, b) {
    const n = a.length, m = b.length;
    const len = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        len[i][j] = a[i] === b[j]
          ? len[i + 1][j + 1] + 1
          : Math.max(len[i + 1][j], len[i][j + 1]);
      }
    }
    const pairs = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) pairs.push([i++, j++]);
      else if (len[i + 1][j] >= len[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  // Changed regions, in document order, each as the span of old blocks it
  // replaces: { start, end, before, after }.
  //
  // A region that rewrites the same number of blocks it replaces is split into
  // one change per block — that is the "reworded every paragraph" case, where
  // each rewrite stands on its own and reviewing them together would put the
  // whole document back on screen. Any other shape (blocks merged, split, added
  // or dropped) is kept whole, because accepting half of it would duplicate or
  // lose text.
  function diffBlocks(oldBlocks, newBlocks) {
    const changes = [];
    const add = (start, end, from, to) => {
      const before = oldBlocks.slice(start, end);
      const after = newBlocks.slice(from, to);
      if (!before.length && !after.length) return;
      if (before.length === after.length) {
        before.forEach((b, k) => changes.push({
          start: start + k, end: start + k + 1, before: [b], after: [after[k]],
        }));
      } else {
        changes.push({ start, end, before, after });
      }
    };
    let i = 0, j = 0;
    for (const [oi, nj] of commonPairs(oldBlocks.map(blockKey), newBlocks.map(blockKey))) {
      add(i, oi, j, nj);
      i = oi + 1;
      j = nj + 1;
    }
    add(i, oldBlocks.length, j, newBlocks.length);
    return changes;
  }

  // The old document with the accepted changes substituted in. Changes are
  // disjoint and in order, so this is one pass. Accepting all of them
  // reproduces the proposal exactly.
  function rebuild(oldBlocks, changes, accepted) {
    const out = [];
    let i = 0;
    changes.forEach((c, idx) => {
      out.push(...oldBlocks.slice(i, c.start), ...(accepted.has(idx) ? c.after : c.before));
      i = c.end;
    });
    out.push(...oldBlocks.slice(i));
    return out;
  }

  function reviewProposal(msg, doc) {
    const proposal = hooks.proposal;
    const box = document.createElement("div");
    box.className = "doc-proposal";
    msg.appendChild(box);

    // Snapshotted here: this is the same text the model was given, so it is
    // what the proposal is a revision of.
    const oldBlocks = proposal.splitBlocks(hooks.getDocument());
    const changes = diffBlocks(oldBlocks, proposal.splitBlocks(doc));
    const accepted = new Set();

    const heading = (t) => {
      const el = document.createElement("div");
      el.className = "dp-head";
      el.innerHTML = "<span></span>";
      el.firstChild.textContent = t;
      return el;
    };

    if (!changes.length) {
      box.appendChild(heading(`${proposal.title}: nothing changed.`));
      return;
    }

    const note = (text) => {
      const el = document.createElement("div");
      el.className = "dp-note";
      el.textContent = text;
      return el;
    };

    // One side of a change — the blocks as they are now, or as proposed.
    //
    // Both sides are always drawn, because which one is missing is the whole
    // story: no "now" side means the block is new, no "proposed" side means it
    // is being dropped. Neither reads as anything if the side is simply absent.
    // A side can also be present and still render to nothing — `<p><br></p>`,
    // the blank spacer paragraphs a rich-text document is full of — and an
    // empty box says just as little, so both cases say it in words instead.
    const side = (cls, label, blocks, whenEmpty) => {
      const wrap = document.createElement("div");
      wrap.className = "dp-side " + cls;
      const tag = document.createElement("div");
      tag.className = "dp-label";
      tag.textContent = label;
      wrap.appendChild(tag);
      if (!blocks.length) {
        wrap.appendChild(note(whenEmpty));
        return wrap;
      }
      const preview = proposal.renderPreview(proposal.joinBlocks(blocks));
      const blank = !preview.textContent.trim() && !preview.querySelector("img, table, hr");
      wrap.appendChild(blank
        ? note(blocks.length > 1 ? "Blank paragraphs" : "A blank paragraph")
        : preview);
      return wrap;
    };

    const finish = () => {
      box.innerHTML = "";
      const done = heading(`${accepted.size} of ${changes.length} change` +
        `${changes.length === 1 ? "" : "s"} accepted.`);
      box.appendChild(done);
      if (!accepted.size) return;
      const btn = document.createElement("button");
      btn.className = "apply-btn";
      btn.textContent = proposal.applyLabel;
      btn.addEventListener("click", () => {
        proposal.apply(proposal.joinBlocks(rebuild(oldBlocks, changes, accepted)));
        btn.textContent = "Applied ✓";
        btn.classList.add("applied");
        btn.disabled = true;
      });
      done.appendChild(btn);
    };

    let at = 0;
    const step = () => {
      if (at >= changes.length) { finish(); return; }
      const c = changes[at];
      box.innerHTML = "";
      box.appendChild(heading(`${proposal.title} — change ${at + 1} of ${changes.length}`));
      const body = document.createElement("div");
      body.className = "dp-body";
      body.appendChild(side("dp-old", "Now", c.before, "Nothing here yet"));
      body.appendChild(side("dp-new", "Proposed", c.after, "Removed"));
      box.appendChild(body);

      const actions = document.createElement("div");
      actions.className = "dp-actions";
      actions.innerHTML =
        `<button class="apply-btn accept-btn">Accept</button>` +
        `<button class="skip-btn">Skip</button>`;
      const answer = (keep) => { if (keep) accepted.add(at); at++; step(); };
      actions.querySelector(".accept-btn").addEventListener("click", () => answer(true));
      actions.querySelector(".skip-btn").addEventListener("click", () => answer(false));
      box.appendChild(actions);
      msg.parentElement.scrollTop = msg.parentElement.scrollHeight;
    };
    step();
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------
  async function loadModels() {
    const data = await (await fetch("/api/models")).json();
    modelSelect.innerHTML = "";
    data.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label + (m.has_key ? "" : " ⚠");
      if (m.id === data.active) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    hooks.onModels?.(data);
    return data;
  }

  async function setActiveModel(id) {
    await fetch("/api/models/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  // Placeholder presets per API type, plus show/hide the API-endpoint field
  // (Anthropic uses a fixed endpoint, so it isn't asked for).
  function applyProviderPreset() {
    const mfProvider = $("#mf-provider");
    const anthropic = $("#mf-api-type").value === "anthropic";
    $("#mf-baseurl-row").hidden = anthropic;
    $("#mf-model").placeholder = anthropic ? "e.g. claude-opus-4-8" : "e.g. gpt-4o  or  qwen2.5";
    $("#mf-api-key-env").placeholder = anthropic ? "e.g. ANTHROPIC_API_KEY" : "e.g. OPENAI_API_KEY";
    $("#mf-base-url").placeholder = "https://api.openai.com/v1  (or http://localhost:11434/v1)";
    // Offer a sensible default provider name without clobbering a custom one.
    if (anthropic && (!mfProvider.value || mfProvider.value === "OpenAI")) mfProvider.value = "Anthropic";
    if (!anthropic && mfProvider.value === "Anthropic") mfProvider.value = "";
  }

  async function openModelModal() {
    ["#mf-label", "#mf-model", "#mf-base-url", "#mf-api-key", "#mf-api-key-env", "#mf-id", "#mf-provider"]
      .forEach((s) => { $(s).value = ""; });
    $("#mf-api-type").value = "anthropic";
    applyProviderPreset();
    $("#mf-error").hidden = true;
    await renderModelList();
    $("#model-modal").hidden = false;
    $("#mf-label").focus();
  }

  // List existing models with a remove button for each.
  async function renderModelList() {
    const data = await (await fetch("/api/models")).json();
    const list = $("#model-list");
    list.innerHTML = "";
    data.models.forEach((m) => {
      const li = document.createElement("li");
      if (m.id === data.active) li.classList.add("active");
      li.innerHTML =
        `<span class="ml-name">${escapeHtml(m.label)}</span>` +
        `<span class="ml-meta">${escapeHtml(m.provider)} · ${escapeHtml(m.model)}</span>` +
        `<button class="ml-del" title="Remove">✕</button>`;
      const del = li.querySelector(".ml-del");
      if (data.models.length <= 1) del.disabled = true;
      del.addEventListener("click", () => deleteModel(m.id, m.label));
      list.appendChild(li);
    });
  }

  async function deleteModel(id, label) {
    if (!(await uiConfirm(`Remove model "${label}"?`))) return;
    const res = await fetch(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      await uiAlert("Could not remove: " + (d.detail || res.statusText));
      return;
    }
    await renderModelList();
    await loadModels();
    addSystemMessage(`Removed model: ${label}`);
  }

  function slugifyModelId(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  }

  async function createModel() {
    const err = $("#mf-error");
    const showError = (m) => { err.textContent = m; err.hidden = false; };

    const apiType = $("#mf-api-type").value;
    const provider = $("#mf-provider").value.trim() || (apiType === "anthropic" ? "Anthropic" : "OpenAI");
    const label = $("#mf-label").value.trim();
    const model = $("#mf-model").value.trim();
    const baseUrl = $("#mf-base-url").value.trim();
    const apiKey = $("#mf-api-key").value.trim();
    const apiKeyEnv = $("#mf-api-key-env").value.trim();
    let id = $("#mf-id").value.trim();

    if (!label) return showError("Display name is required.");
    if (!model) return showError("Model ID is required.");
    if (!id) id = slugifyModelId(label);

    const body = { id, label, provider, api_type: apiType, model };
    if (apiType === "openai" && baseUrl) body.base_url = baseUrl;
    if (apiKey) body.api_key = apiKey;
    if (apiKeyEnv) body.api_key_env = apiKeyEnv;

    const submit = $("#mf-submit");
    submit.disabled = true;
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || res.statusText);
      }
      $("#model-modal").hidden = true;
      await loadModels();
      // Switch to the model that was just added.
      modelSelect.value = id;
      await setActiveModel(id);
      addSystemMessage(`Added and switched to model: ${label}`);
    } catch (e2) {
      showError("Could not add model: " + e2.message);
    } finally {
      submit.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------
  async function openSkills() {
    await renderSkills();
    $("#skills-modal").hidden = false;
  }

  async function renderSkills() {
    const data = await (await fetch("/api/skills")).json();
    const list = $("#skills-list");
    list.innerHTML = "";
    if (!data.skills.length) {
      list.innerHTML = "<li class='hint'>No skills yet. Create one below.</li>";
    }
    data.skills.forEach((s) => {
      const li = document.createElement("li");
      const loaded = data.active.includes(s.name);
      li.innerHTML = `<input type="checkbox" ${loaded ? "checked" : ""}>
        <span class="sk-name">${escapeHtml(s.name)}</span>
        <span class="sk-desc">${escapeHtml(s.description || "")}</span>
        <button class="sk-del">Delete</button>`;
      li.querySelector("input").addEventListener("change", async () => {
        const active = [...list.querySelectorAll("li")]
          .filter((el) => el.querySelector("input")?.checked)
          .map((el) => el.querySelector(".sk-name")?.textContent);
        await fetch("/api/skills/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active }),
        });
      });
      li.querySelector(".sk-del").addEventListener("click", async () => {
        await fetch(`/api/skills/${encodeURIComponent(s.name)}`, { method: "DELETE" });
        renderSkills();
      });
      list.appendChild(li);
    });
  }

  async function createSkill() {
    const name = $("#skill-name").value.trim();
    const body = $("#skill-body").value.trim();
    if (!name) { await uiAlert("Skill name is required."); return; }
    await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, body }),
    });
    $("#skill-name").value = "";
    $("#skill-body").value = "";
    renderSkills();
  }

  // -------------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------------
  async function handleCommand(text) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "help":
        addSystemMessage(
          "Commands:\n" +
          "/help — show this help\n" +
          "/new — open a new conversation tab\n" +
          "/models — list available models\n" +
          "/model <id> — switch active model\n" +
          "/skills — open the skills panel\n" +
          "/skill new <name> — create a skill (opens panel)\n" +
          "/skill load <name> — load a skill\n" +
          "/clear — clear this conversation");
        break;
      case "new":
        createSession();
        addSystemMessage("New conversation. Type /help for commands.");
        break;
      case "models": {
        const data = await (await fetch("/api/models")).json();
        addSystemMessage(data.models.map((m) =>
          `${m.id === data.active ? "● " : "○ "}${m.id} — ${m.label}`).join("\n"));
        break;
      }
      case "model":
        if (!arg) { addSystemMessage("Usage: /model <id>"); break; }
        await setActiveModel(arg);
        await loadModels();
        addSystemMessage(`Active model: ${arg}`);
        break;
      case "skills":
        openSkills();
        break;
      case "skill": {
        const [sub, ...nameParts] = rest;
        const name = nameParts.join(" ");
        if (sub === "new") {
          openSkills();
          if (name) $("#skill-name").value = name;
        } else if (sub === "load" && name) {
          const data = await (await fetch("/api/skills")).json();
          const active = Array.from(new Set([...data.active, name]));
          await fetch("/api/skills/active", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active }),
          });
          addSystemMessage(`Loaded skill: ${name}`);
        } else {
          addSystemMessage("Usage: /skill new <name> | /skill load <name>");
        }
        break;
      }
      case "clear": {
        const s = activeSession();
        s.history = [];
        s.el.innerHTML = "";
        s.title = `Chat ${s.id}`;
        s.autoTitle = true;
        renderTabs();
        addSystemMessage("Conversation cleared.");
        break;
      }
      default:
        addSystemMessage(`Unknown command: /${cmd}. Try /help.`);
    }
  }

  // -------------------------------------------------------------------------
  // Show / hide + draggable resize
  // -------------------------------------------------------------------------
  let aiWidth = 420;   // remembered width so re-opening restores the last size

  function toggleAI() {
    const collapsed = !aiPane.classList.contains("collapsed");
    if (collapsed) aiWidth = aiPane.getBoundingClientRect().width || aiWidth;
    aiPane.classList.toggle("collapsed", collapsed);
    divider.classList.toggle("collapsed", collapsed);
    $("#toggle-ai")?.classList.toggle("active", !collapsed);
    if (!collapsed) aiPane.style.flex = `0 0 ${aiWidth}px`;
  }

  function wireDivider() {
    let dragging = false;
    divider.addEventListener("mousedown", (e) => {
      dragging = true;
      divider.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      // The divider's parent is the flex row holding both panes on either page.
      const row = aiPane.parentElement.getBoundingClientRect();
      let w = row.right - e.clientX;
      w = Math.max(300, Math.min(w, row.width - 380));   // clamp both panes
      aiWidth = w;
      aiPane.style.flex = `0 0 ${w}px`;
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------
  // options:
  //   mode          "latex", or omitted for the rich-text editor
  //   placeholder   composer placeholder text
  //   getDocument   () => the document text to send as context
  //   getSelection  () => the selected passage to highlight, if the page has one
  //   proposal      { title, applyLabel, renderPreview(text) -> Element,
  //                   splitBlocks(doc) -> string[], joinBlocks(blocks) -> doc,
  //                   apply(doc) } — how an ai_words:document block is shown
  //                   and what applying it does. The split/join pair is what
  //                   lets the pane review a proposal block by block without
  //                   knowing whether a block is an HTML element or a LaTeX
  //                   paragraph.
  //   onModels      (data) => void, for anything else the page reads off
  //                   /api/models (the LaTeX editor reads `tex`)
  //
  // Returns a promise that resolves once the model list has loaded.
  function init(options) {
    hooks = options;

    aiPane = $("#ai-pane");
    divider = $("#divider");
    aiPane.innerHTML = PANE_HTML(options.placeholder);
    document.body.insertAdjacentHTML("beforeend", MODALS_HTML);

    tabListEl = $("#tab-list");
    panelsEl = $("#tab-panels");
    chatInput = $("#chat-input");
    sendBtn = $("#send-btn");
    stopBtn = $("#stop-btn");
    modelSelect = $("#model-select");
    chatInput.placeholder = options.placeholder;

    chatInput.addEventListener("input", () => {
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
    });
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    sendBtn.addEventListener("click", send);
    stopBtn.addEventListener("click", () => streamAbort?.abort());
    $("#tab-add").addEventListener("click", () => createSession());
    modelSelect.addEventListener("change", async () => {
      await setActiveModel(modelSelect.value);
      addSystemMessage(`Switched model to ${modelSelect.options[modelSelect.selectedIndex].text}`);
    });
    $("#mf-api-type").addEventListener("change", applyProviderPreset);

    // The pane owns its own actions, so neither page has to dispatch them.
    document.addEventListener("click", (e) => {
      switch (e.target.closest("[data-act]")?.dataset.act) {
        case "toggle-ai": toggleAI(); break;
        case "skills": openSkills(); break;
        case "close-skills": $("#skills-modal").hidden = true; break;
        case "create-skill": createSkill(); break;
        case "add-model": openModelModal(); break;
        case "close-model": $("#model-modal").hidden = true; break;
        case "create-model": createModel(); break;
      }
    });

    wireDivider();
    $("#toggle-ai")?.classList.add("active");   // the panel starts visible
    createSession();
    addSystemMessage("Assistant ready. Type /help for commands.");
    return loadModels();
  }

  return { init, addSystemMessage };
})();
