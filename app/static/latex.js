"use strict";

// LaTeX editor: a source pane and an AI assistant. Compilation shells out to a
// LaTeX engine on the server (/api/latex/render) and the resulting PDF is pushed
// to a separate browser tab (pdfview.html), so it never competes with the source
// and the chat for width. When no engine is installed the log shows a notice and
// editing still works.

// $ and the AI pane itself come from ui.js / ai-pane.js, loaded first.
const source = $("#tex-source");
const logEl = $("#tex-log");
const statusEl = $("#tex-status");
const docNameEl = $("#doc-name");

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
// AI assistant
//
// The pane itself — conversation tabs, chat, slash commands, the models and
// skills panels, the resize divider — is ai-pane.js, shared with the rich-text
// editor. Only what is actually about LaTeX stays here: what counts as "the
// document", and what applying a proposed one does.
// ---------------------------------------------------------------------------
const aiReady = AiPane.init({
  mode: "latex",
  placeholder: "Ask about the LaTeX document, or /help for commands…",
  getDocument: () => source.value,
  proposal: {
    title: "Proposed LaTeX source",
    applyLabel: "Apply to editor",
    // .tex is source, not markup: show it verbatim instead of rendering it.
    renderPreview: (doc) => {
      const pre = document.createElement("pre");
      pre.className = "dp-preview";
      pre.textContent = doc;
      return pre;
    },
    apply: (doc) => {
      source.value = doc;
      if (texAvailable) compile();
    },
  },
  // /api/models also reports whether the server found a LaTeX engine.
  onModels: (data) => {
    texAvailable = !!data.tex;
    if (texAvailable) return;
    showLog(
      "No LaTeX engine detected on the server.\n\n" +
      "Install tectonic (recommended) or a TeX distribution to enable the PDF " +
      "preview. Editing and the AI assistant still work.",
      true);
    setStatus("No compiler", "error");
  },
});

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
// AiPane.init resolves once /api/models has answered, which is what tells us
// whether there is an engine to compile the first preview with.
aiReady.then(() => { if (texAvailable) compile(); });
