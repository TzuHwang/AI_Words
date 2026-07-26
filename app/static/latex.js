"use strict";

// LaTeX editor: a source pane and an AI assistant. Compilation shells out to a
// LaTeX engine on the server (/api/latex/render) and the resulting PDF is pushed
// to a separate browser tab (pdfview.html), so it never competes with the source
// and the chat for width. When no engine is installed the log shows a notice and
// editing still works.

const $ = (sel) => document.querySelector(sel);
const source = $("#tex-source");
const logEl = $("#tex-log");
const statusEl = $("#tex-status");
const docNameEl = $("#doc-name");
const chatInput = $("#chat-input");
const sendBtn = $("#send-btn");
const stopBtn = $("#stop-btn");
const modelSelect = $("#model-select");

const DEFAULT_TEX = `\\documentclass{article}
\\begin{document}

\\section{Hello}
Start writing LaTeX here, then press \\textbf{Compile}.

\\end{document}
`;

let docName = "untitled.tex";
let fileHandle = null;                 // writable handle for Ctrl+S, when available
const supportsFsa = "showOpenFilePicker" in window;
let texAvailable = true;               // set from /api/models; gates auto-compile
let lastPdf = null;                    // bytes of the most recent PDF
let lastSource = null;                 // source that produced it
let previewWin = null;                 // the viewer tab, while it is open
let streaming = false;
let streamAbort = null;

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------
let compileTimer = 0;
let compileAbort = null;
let lastCompileMs = 700;               // measured; drives the debounce below

// Wait about as long as a compile costs: a document that builds in 300ms can
// preview almost live, while a slow one doesn't get a queue of runs piled on it.
function debounceMs() {
  return Math.min(2000, Math.max(400, Math.round(lastCompileMs)));
}

function scheduleCompile() {
  if (!$("#auto-compile").checked || !texAvailable) return;
  if (source.value === lastSource) return;    // nothing changed since last compile
  clearTimeout(compileTimer);
  compileTimer = setTimeout(compile, debounceMs());
}

async function compile() {
  clearTimeout(compileTimer);
  compileAbort?.abort();               // drop the in-flight run; the server kills it too
  const run = (compileAbort = new AbortController());
  setStatus("Compiling…", "");
  const src = source.value;
  const started = performance.now();
  try {
    const res = await fetch("/api/latex/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: src }),
      signal: run.signal,
    });
    if (res.status === 409) return;    // superseded by a newer compile
    lastCompileMs = performance.now() - started;
    if (res.ok) {
      lastPdf = await res.arrayBuffer();
      lastSource = src;
      pushPdf();
      logEl.hidden = true;
      setStatus(previewOpen() ? "Compiled ✓" : "Compiled ✓ — open 🗔 PDF", "ok");
    } else {
      const data = await res.json().catch(() => ({}));
      showLog(data.error || res.statusText, false);
      setStatus("Compile failed", "error");
    }
  } catch (err) {
    if (err.name === "AbortError") return;   // replaced by a newer compile
    showLog("Request failed: " + err.message, false);
    setStatus("Compile failed", "error");
  } finally {
    if (compileAbort === run) compileAbort = null;
  }
}

function previewOpen() {
  return !!previewWin && !previewWin.closed;
}

// Hand the PDF to the viewer tab, which redraws in place without a reload. The
// buffer is detached by the transfer, so a copy is sent and `lastPdf` is kept
// for the next viewer that asks for it.
function pushPdf() {
  if (!previewOpen() || !lastPdf) return;
  const copy = lastPdf.slice(0);
  previewWin.postMessage(
    { from: "aiwords", type: "pdf", name: docName, data: copy },
    location.origin, [copy]);
}

// Open (or re-focus) the viewer tab. window.open must run inside the click that
// asked for it, so this is never called from the auto-compile path — those
// compiles only push to a tab that is already open. An open tab is never
// navigated again: reloading it would throw away its scroll position and zoom.
function openPreview() {
  if (previewOpen()) { previewWin.focus(); return; }
  previewWin = window.open("/static/pdfview.html", "aiwords-pdf");
  if (!previewWin) setStatus("Preview blocked — allow pop-ups", "error");
}

// The viewer asks for the current PDF once it has booted.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.from === "aiwords-pdfview" && e.data.type === "ready") pushPdf();
});

// Show a message under the source. `notice` = neutral (e.g. no engine), else error.
function showLog(text, notice) {
  logEl.textContent = text;
  logEl.classList.toggle("notice", !!notice);
  logEl.hidden = false;
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "tex-status" + (kind ? " " + kind : "");
}

source.addEventListener("input", scheduleCompile);
$("#auto-compile").addEventListener("change", () => {
  if ($("#auto-compile").checked) scheduleCompile();
});

// ---------------------------------------------------------------------------
// Toolbar actions
// ---------------------------------------------------------------------------
document.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  switch (act) {
    case "compile": openPreview(); compile(); break;
    case "preview":
      openPreview();
      if (!lastPdf && texAvailable) compile();
      break;
    case "new": newDoc(); break;
    case "open": openDoc(); break;
    case "save": saveToFile(); break;
    case "toggle-ai": toggleAI(); break;
  }
});

// Tab inserts two spaces instead of moving focus out of the source box.
source.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const s = source.selectionStart, end = source.selectionEnd;
    source.setRangeText("  ", s, end, "end");
  }
});

async function newDoc() {
  if (source.value.trim() && !confirm("Start a new document? Unsaved changes will be lost.")) return;
  setSource(DEFAULT_TEX, "untitled.tex");
  fileHandle = null;
}

function setSource(text, name) {
  source.value = text;
  if (name) { docName = name; docNameEl.textContent = name; }
  if (texAvailable) compile();
}

// -- open (.tex) ------------------------------------------------------------
const fileInput = $("#tex-file");
async function openDoc() {
  if (!supportsFsa) { fileInput.click(); return; }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      types: [{ description: "LaTeX", accept: { "text/x-tex": [".tex"] } }],
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    return;
  }
  const file = await handle.getFile();
  setSource(await file.text(), file.name);
  fileHandle = handle;
}
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileHandle = null;
  setSource(await file.text(), file.name);
  fileInput.value = "";
});

// -- save (.tex) ------------------------------------------------------------
async function saveToFile() {
  const blob = new Blob([source.value], { type: "text/x-tex" });
  try {
    if (fileHandle) {
      await writeBlob(fileHandle, blob);
      setStatus(`Saved ${fileHandle.name}`, "ok");
      return;
    }
    if (supportsFsa && window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: docName,
        types: [{ description: "LaTeX", accept: { "text/x-tex": [".tex"] } }],
      });
      await writeBlob(handle, blob);
      fileHandle = handle;
      docName = handle.name;
      docNameEl.textContent = handle.name;
      setStatus(`Saved ${handle.name}`, "ok");
      return;
    }
    download(blob, docName);                    // last resort
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus("Save failed: " + err.message, "error");
  }
}
async function writeBlob(handle, blob) {
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    saveToFile();
  }
});

// ---------------------------------------------------------------------------
// AI pane: show / hide + draggable resize
//
// Deliberately the same behaviour and the same numbers as the ODT editor's pane
// in app.js: same starting width, same clamps, same divider. The two pages share
// their markup and CSS for this, but not their scripts, so the handlers are
// spelled out in both.
// ---------------------------------------------------------------------------
const aiPane = $("#ai-pane");
const divider = $("#divider");
let aiWidth = 420; // remembered width so re-opening restores the last size

function toggleAI() {
  const collapsed = !aiPane.classList.contains("collapsed");
  if (collapsed) aiWidth = aiPane.getBoundingClientRect().width || aiWidth;
  aiPane.classList.toggle("collapsed", collapsed);
  divider.classList.toggle("collapsed", collapsed);
  $("#toggle-ai").classList.toggle("active", !collapsed);
  if (!collapsed) aiPane.style.flex = `0 0 ${aiWidth}px`;
}

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
  const main = $(".tex-main").getBoundingClientRect();
  let w = main.right - e.clientX;
  w = Math.max(300, Math.min(w, main.width - 380)); // clamp both panes
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

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
async function loadModels() {
  const data = await (await fetch("/api/models")).json();
  texAvailable = !!data.tex;
  modelSelect.innerHTML = "";
  data.models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label + (m.has_key ? "" : " ⚠");
    if (m.id === data.active) opt.selected = true;
    modelSelect.appendChild(opt);
  });
  if (!texAvailable) {
    showLog(
      "No LaTeX engine detected on the server.\n\n" +
      "Install tectonic (recommended) or a TeX distribution to enable the PDF " +
      "preview. Editing and the AI assistant still work.",
      true);
    setStatus("No compiler", "error");
  }
}
modelSelect.addEventListener("change", async () => {
  await fetch("/api/models/active", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: modelSelect.value }),
  });
});

// ---------------------------------------------------------------------------
// Chat (single conversation)
// ---------------------------------------------------------------------------
const messagesEl = $("#messages");
let history = [];

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => streamAbort?.abort());

async function send() {
  const text = chatInput.value.trim();
  if (!text || streaming) return;
  chatInput.value = "";
  chatInput.style.height = "auto";
  addMessage("user", text);
  history.push({ role: "user", content: text });
  await streamAssistant();
}

async function streamAssistant() {
  streaming = true;
  streamAbort = new AbortController();
  sendBtn.hidden = true; stopBtn.hidden = false;
  const { msg, bubble } = addMessage("assistant", "");
  let full = "";
  const render = () => {
    const { text } = stripDocBlock(full);
    bubble.innerHTML = renderMarkdown(text) ||
      `<span class="reasoning"><span class="spin"></span>Reasoning…</span>`;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  render();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, document_html: source.value, mode: "latex" }),
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
        if (payload.delta) { full += payload.delta; render(); }
      }
    }
    history.push({ role: "assistant", content: full });
    finalizeAssistant(msg, bubble, full);
  } catch (err) {
    if (err.name === "AbortError") {
      if (full.trim()) { history.push({ role: "assistant", content: full }); finalizeAssistant(msg, bubble, full); }
      else bubble.innerHTML = `<span style="color:var(--text-dim)">Stopped.</span>`;
    } else {
      bubble.innerHTML = `<span style="color:var(--accent)">Error: ${escapeHtml(err.message)}</span>`;
    }
  } finally {
    streaming = false; streamAbort = null;
    sendBtn.hidden = false; stopBtn.hidden = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// An ai_words:document block holds the full revised .tex source. Offer to apply
// it to the editor (and recompile).
function finalizeAssistant(msg, bubble, full) {
  const { text, doc } = stripDocBlock(full);
  bubble.innerHTML = renderMarkdown(text);
  if (doc == null) return;
  const box = document.createElement("div");
  box.className = "doc-proposal";
  box.innerHTML =
    `<div class="dp-head"><span>Proposed LaTeX source</span>` +
    `<button class="apply-btn">Apply to editor</button></div>` +
    `<pre class="dp-preview"></pre>`;
  box.querySelector(".dp-preview").textContent = doc;
  const btn = box.querySelector(".apply-btn");
  btn.addEventListener("click", () => {
    source.value = doc;
    if (texAvailable) compile();
    btn.textContent = "Applied ✓";
    btn.classList.add("applied");
    btn.disabled = true;
  });
  msg.appendChild(box);
}

function stripThinking(text) {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = t.lastIndexOf("<think>");
  if (open !== -1 && t.indexOf("</think>", open) === -1) t = t.slice(0, open);
  return t.trim();
}
function stripDocBlock(text) {
  text = stripThinking(text);
  const re = /```ai_words:document\s*\n([\s\S]*?)```/;
  const m = text.match(re);
  if (!m) return { text, doc: null };
  return { text: text.replace(re, "").trim(), doc: m[1].trim() };
}

function addMessage(role, content) {
  const msg = document.createElement("div");
  msg.className = "msg " + role;
  const label = role === "user" ? "You" : role === "assistant" ? "Assistant" : "";
  msg.innerHTML = `${label ? `<span class="role">${label}</span>` : ""}<div class="bubble"></div>`;
  msg.querySelector(".bubble").innerHTML = renderMarkdown(content);
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { msg, bubble: msg.querySelector(".bubble") };
}

function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return html;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function consumeHandoff() {
  const raw = sessionStorage.getItem("aiwords.pending");
  if (!raw) return false;
  sessionStorage.removeItem("aiwords.pending");
  let pending;
  try { pending = JSON.parse(raw); } catch (_) { return false; }
  if (!pending || pending.mode !== "latex") return false;
  source.value = pending.content || DEFAULT_TEX;
  docName = pending.filename || "untitled.tex";
  docNameEl.textContent = docName;
  return true;
}

if (!consumeHandoff()) source.value = DEFAULT_TEX;
loadModels().then(() => { if (texAvailable) compile(); });
