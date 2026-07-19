"use strict";

const $ = (sel) => document.querySelector(sel);
const editor = $("#editor");
const chatInput = $("#chat-input");
const sendBtn = $("#send-btn");
const modelSelect = $("#model-select");
const docNameEl = $("#doc-name");

let docName = "Untitled";
let streaming = false;

// A writable handle to the file the document was opened from, when the File
// System Access API is available. Ctrl+S writes straight back to it; otherwise
// it's null and saving falls back to a Save-As picker or a download.
let fileHandle = null;
const supportsFsa = "showOpenFilePicker" in window;

// ---------------------------------------------------------------------------
// In-page dialogs — native alert/confirm/prompt are blocked in embedded
// webviews (e.g. VS Code's Simple Browser), where calling them freezes the
// page. These Promise-based equivalents render inside the document instead.
// ---------------------------------------------------------------------------
function uiDialog(kind, message, value) {
  return new Promise((resolve) => {
    const hasInput = kind === "prompt";
    const overlay = document.createElement("div");
    overlay.className = "modal dlg-overlay";
    overlay.innerHTML =
      `<div class="modal-box dlg">` +
      `<div class="dlg-msg"></div>` +
      (hasInput ? `<input class="dlg-input">` : ``) +
      `<div class="dlg-actions">` +
      (kind === "alert" ? `` : `<button class="dlg-cancel">Cancel</button>`) +
      `<button class="dlg-ok">OK</button></div></div>`;
    overlay.querySelector(".dlg-msg").textContent = message;
    const input = overlay.querySelector(".dlg-input");
    if (input && value != null) input.value = value;
    document.body.appendChild(overlay);
    (input || overlay.querySelector(".dlg-ok")).focus();

    const done = (result) => { overlay.remove(); resolve(result); };
    const okValue = () => (kind === "confirm" ? true : kind === "prompt" ? input.value : undefined);
    const cancelValue = () => (kind === "confirm" ? false : null);
    overlay.querySelector(".dlg-ok").addEventListener("click", () => done(okValue()));
    overlay.querySelector(".dlg-cancel")?.addEventListener("click", () => done(cancelValue()));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(okValue()); }
      else if (e.key === "Escape") { e.preventDefault(); done(cancelValue()); }
    });
    // Clicking the dark backdrop dismisses like Cancel.
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) done(cancelValue());
    });
  });
}
const uiAlert = (message) => uiDialog("alert", message);
const uiConfirm = (message) => uiDialog("confirm", message);
const uiPrompt = (message, value = "") => uiDialog("prompt", message, value);

// Prefer inline CSS styling for execCommand (font-family, colors, size).
try { document.execCommand("styleWithCSS", false, true); } catch (_) {}

// Replace the whole document body while keeping it on the native undo stack.
// Assigning editor.innerHTML directly wipes the contenteditable undo history,
// so Ctrl+Z can't revert an AI edit — go through execCommand instead.
function replaceEditorContent(html) {
  editor.focus();
  document.execCommand("selectAll", false, null);
  // insertHTML records the replacement as one undoable step.
  const ok = document.execCommand("insertHTML", false, html);
  if (!ok) editor.innerHTML = html; // fallback if the command is unsupported
  updateWordCount();
  schedulePaginate();
}

// ---------------------------------------------------------------------------
// Editor: inline / block formatting commands
// ---------------------------------------------------------------------------
function exec(cmd, value = null) {
  editor.focus();
  document.execCommand(cmd, false, value);
  updateWordCount();
  schedulePaginate();
}

document.querySelectorAll("[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => {
    exec(btn.dataset.cmd);
    closeMenus();
  });
});

// Paragraph style dropdown
$("#style-select").addEventListener("change", (e) => {
  exec("formatBlock", e.target.value);
});

// Font family
$("#font-select").addEventListener("change", (e) => {
  exec("fontName", e.target.value);
});

// Font size — execCommand only accepts 1–7, so tag then rewrite to pt.
$("#size-select").addEventListener("change", (e) => {
  const pt = e.target.value;
  editor.focus();
  document.execCommand("fontSize", false, "7");
  editor.querySelectorAll('font[size="7"]').forEach((f) => {
    f.removeAttribute("size");
    f.style.fontSize = pt + "pt";
  });
  updateWordCount();
  schedulePaginate();
});

// Colors
$("#fore-color").addEventListener("input", (e) => {
  exec("foreColor", e.target.value);
  e.target.previousElementSibling.style.borderBottomColor = e.target.value;
});
$("#back-color").addEventListener("input", (e) => {
  exec("hiliteColor", e.target.value);
  e.target.previousElementSibling.style.color = e.target.value;
});

// ---------------------------------------------------------------------------
// Menu bar: click a top-level menu to open, click elsewhere to close
// ---------------------------------------------------------------------------
function closeMenus() {
  document.querySelectorAll(".lo-menu.open").forEach((m) => m.classList.remove("open"));
  document.querySelectorAll(".lo-menu-list.open").forEach((m) => m.classList.remove("open"));
}
document.querySelectorAll(".lo-menu .lo-menu-label").forEach((label) => {
  label.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = label.parentElement;
    const wasOpen = menu.classList.contains("open");
    closeMenus();
    if (!wasOpen) menu.classList.add("open");
  });
});

// ---------------------------------------------------------------------------
// Toolbar / menu actions (open / save / new / insert / skills)
// ---------------------------------------------------------------------------
document.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) { closeMenus(); return; }
  switch (act) {
    case "open": openDoc(); break;
    case "save": saveToFile(); break;
    case "save-menu": {
      const menu = $("#save-menu");
      const open = menu.classList.contains("open");
      closeMenus();
      if (!open) menu.classList.add("open");
      e.stopPropagation();
      return;
    }
    case "save-odt": exportDoc("odt"); break;
    case "save-html": exportDoc("html"); break;
    case "new": newDoc(); break;
    case "insert-hr": exec("insertHorizontalRule"); break;
    case "insert-page-break": insertPageBreak(); break;
    case "insert-table": insertTable(); break;
    case "insert-link": insertLink(); break;
    case "toggle-ai": toggleAI(); break;
    case "skills": openSkills(); break;
    case "close-skills": $("#skills-modal").hidden = true; break;
    case "create-skill": createSkill(); break;
    case "add-model": openModelModal(); break;
    case "close-model": $("#model-modal").hidden = true; break;
    case "create-model": createModel(); break;
    case "about":
      uiAlert("AI Words — a LibreOffice-style document editor with an AI assistant.");
      break;
  }
  closeMenus();
});

async function insertTable() {
  const spec = await uiPrompt("Table size as rows x columns:", "3x3");
  if (!spec) return;
  const m = spec.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!m) { await uiAlert("Enter it like 3x3."); return; }
  const rows = Math.min(+m[1], 50), cols = Math.min(+m[2], 20);
  let html = '<table><tbody>';
  for (let r = 0; r < rows; r++) {
    html += "<tr>" + '<td><br></td>'.repeat(cols) + "</tr>";
  }
  html += "</tbody></table><p><br></p>";
  exec("insertHTML", html);
}

async function insertLink() {
  const url = await uiPrompt("Link URL:", "https://");
  if (url) exec("createLink", url);
}

// Send a File's bytes through the server converter and load the result.
async function importFile(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/import", { method: "POST", body: form });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  const data = await res.json();
  editor.innerHTML = data.html || "<p><br></p>";
  docName = file.name.replace(/\.[^.]+$/, "");
  docNameEl.textContent = data.filename || docName;
  updateWordCount();
  schedulePaginate();
}

// Open a document. Prefer the File System Access API so a later Ctrl+S can write
// straight back to the same file; fall back to a plain upload where it's absent
// (in that case there's no handle, so Ctrl+S will prompt for a Save-As target).
async function openDoc() {
  if (!supportsFsa) { $("#file-input").click(); return; }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      types: [{
        description: "Documents",
        accept: {
          "application/vnd.oasis.opendocument.text": [".odt"],
          "text/html": [".html", ".htm"],
        },
      }],
    });
  } catch (err) {
    if (err.name === "AbortError") return;  // user dismissed the picker
    await uiAlert("Open failed: " + err.message);
    return;
  }
  try {
    await importFile(await handle.getFile());
    fileHandle = handle;
  } catch (err) {
    await uiAlert("Import failed: " + err.message);
  }
}

// <input type=file> path — the fallback opener when the File System Access API
// is unavailable. It yields no writable handle, so Ctrl+S will Save-As.
$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    fileHandle = null;
    await importFile(file);
  } catch (err) {
    await uiAlert("Import failed: " + err.message);
  }
  e.target.value = "";
});

// Serialize the current document to ODT/HTML bytes on the server.
async function buildExportBlob(fmt) {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html: cleanDocHtml(), format: fmt, filename: docName }),
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.blob();
}

async function exportDoc(fmt) {
  closeMenus();
  try {
    const blob = await buildExportBlob(fmt);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docName}.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    await uiAlert("Export failed: " + err.message);
  }
}

async function writeBlobToHandle(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

// Ctrl+S — write the document back to its original file in place. If it was
// opened without a writable handle (no File System Access API, or a brand-new
// document), prompt once for a Save-As target and remember it; if even that is
// unavailable, fall back to a plain download.
async function saveToFile() {
  closeMenus();
  try {
    if (fileHandle) {
      const ext = (fileHandle.name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
      const fmt = ext === "html" || ext === "htm" ? "html" : "odt";
      await writeBlobToHandle(fileHandle, await buildExportBlob(fmt));
      toast(`Saved ${fileHandle.name}`);
      return;
    }
    if (supportsFsa && window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${docName}.odt`,
        types: [{
          description: "OpenDocument Text",
          accept: { "application/vnd.oasis.opendocument.text": [".odt"] },
        }],
      });
      await writeBlobToHandle(handle, await buildExportBlob("odt"));
      fileHandle = handle;
      docName = handle.name.replace(/\.[^.]+$/, "");
      docNameEl.textContent = handle.name;
      toast(`Saved ${handle.name}`);
      return;
    }
    await exportDoc("odt");   // last resort: download a copy
  } catch (err) {
    if (err.name === "AbortError") return;  // user cancelled the Save-As dialog
    await uiAlert("Save failed: " + err.message);
  }
}

// A brief status-bar-style flash, e.g. after a save.
let toastTimer = 0;
function toast(msg) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

async function newDoc() {
  if (editor.textContent.trim() && !(await uiConfirm("Start a new document? Unsaved changes will be lost."))) return;
  editor.innerHTML = "<h1>Untitled</h1><p><br></p>";
  docName = "Untitled";
  docNameEl.textContent = docName;
  fileHandle = null;   // no longer tied to the previously opened file
  updateWordCount();
  schedulePaginate();
}

// ---------------------------------------------------------------------------
// Status bar: word count + zoom
// ---------------------------------------------------------------------------
function updateWordCount() {
  const words = (editor.textContent.trim().match(/\S+/g) || []).length;
  $("#word-count").textContent = words === 1 ? "1 word" : `${words} words`;
}
editor.addEventListener("input", updateWordCount);

// ---------------------------------------------------------------------------
// View — zoom and scroll anchoring
//
// The page always occupies its true A4 layout width and zoom is only a CSS
// transform on top of it, so the text never reflows to fit the pane: a narrow
// pane scrolls over a full-size page instead of squashing it. A transform has
// no layout size, so #page-wrap is kept at the scaled footprint to give the
// canvas a scroll area that matches what's on screen.
//
// Zooming and resizing the pane both hold the *focal point* still: the point of
// the document under the mouse when it's over the canvas, otherwise the point at
// the canvas's centre. A resize is only observable after it has happened, so the
// anchor is captured continuously rather than measured on the way in.
// ---------------------------------------------------------------------------
const canvas = $("#editor-canvas");
const pageEl = document.querySelector(".page");
const pageWrap = $("#page-wrap");
const zoomRange = $("#zoom-range");
const ZOOM_MIN = 0.2, ZOOM_MAX = 4;
let zoom = 1;

let pointer = null; // last mouse position over the canvas; null while outside

function focalPoint() {
  const r = canvas.getBoundingClientRect();
  if (pointer &&
      pointer.x >= r.left && pointer.x <= r.right &&
      pointer.y >= r.top && pointer.y <= r.bottom) {
    return { x: pointer.x - r.left, y: pointer.y - r.top };
  }
  return { x: r.width / 2, y: r.height / 2 };
}

// The page's box in the canvas's scrollable content coordinates.
function pageBox() {
  const c = canvas.getBoundingClientRect();
  const w = pageWrap.getBoundingClientRect();
  return {
    x: w.left - c.left + canvas.scrollLeft,
    y: w.top - c.top + canvas.scrollTop,
    w: w.width || 1,
    h: w.height || 1,
  };
}

// Where the focal point lands on the page, as a fraction of the page box —
// a scale-independent handle on "the spot the user is looking at".
let anchor = { rx: 0.5, ry: 0 };
function captureAnchor() {
  const f = focalPoint(), b = pageBox();
  anchor = {
    rx: (canvas.scrollLeft + f.x - b.x) / b.w,
    ry: (canvas.scrollTop + f.y - b.y) / b.h,
  };
}
// Scroll that spot back under the focal point. Re-reading focalPoint() here is
// what makes a resize zoom about the *new* centre rather than the old one.
function restoreAnchor() {
  const f = focalPoint(), b = pageBox();
  canvas.scrollLeft = b.x + anchor.rx * b.w - f.x;
  canvas.scrollTop = b.y + anchor.ry * b.h - f.y;
}
// Anything that moves the focal point re-captures, so the stored fraction always
// describes the spot under the *current* focal point — including the handover
// when the mouse leaves and the centre takes over. Capturing against one focal
// point and restoring against another would shove that spot across the canvas.
canvas.addEventListener("scroll", captureAnchor, { passive: true });
canvas.addEventListener("pointermove", (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  captureAnchor();
});
canvas.addEventListener("pointerleave", () => { pointer = null; captureAnchor(); });

function sizePageWrap() {
  pageWrap.style.width = pageEl.offsetWidth * zoom + "px";
  pageWrap.style.height = pageEl.offsetHeight * zoom + "px";
}

function setZoom(z) {
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  captureAnchor();
  zoom = z;
  pageEl.style.transform = `scale(${z})`;
  sizePageWrap();
  const pct = Math.round(z * 100);
  zoomRange.value = pct;
  $("#zoom-label").textContent = pct + "%";
  restoreAnchor();
}

zoomRange.addEventListener("input", (e) => setZoom(Number(e.target.value) / 100));
canvas.addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(zoom * Math.exp(-e.deltaY / 400));
}, { passive: false });

// Resizing the pane (dragging the divider, collapsing the AI panel, resizing the
// window) keeps the anchored spot in place instead of letting the page drift.
new ResizeObserver(() => { restoreAnchor(); }).observe(canvas);

// ---------------------------------------------------------------------------
// Pagination — flow the document across real A4 sheets (Office-style)
//
// contenteditable is one continuous flow, so we simulate page layout without
// splitting the DOM (which would disturb the caret):
//   1. Measure every top-level block in its natural flow.
//   2. Assign blocks to pages: a block that would overflow the text area of the
//      current page starts a new page instead. A manual ".page-break" marker
//      forces the following block onto a new page.
//   3. Push the first block of each page down with margin so its text lands at
//      that page's top margin, leaving the rest of the previous page blank.
//   4. Paint one fixed-height A4 .sheet behind each page (in #page-backdrop),
//      separated by a gutter. Because every page's text sits between its sheet's
//      top and bottom margins, text never falls on a gutter.
// A single block taller than one page can't be split, so its sheet simply grows
// to contain it (the sheet stays whole — still no text on a gutter).
// ---------------------------------------------------------------------------
const PAGE_CM = 29.7;   // A4 height
const GUTTER_CM = 0.7;  // gap between sheets
const MARGIN_CM = 2;    // top & bottom text margin on every sheet
const backdrop = $("#page-backdrop");

// Convert cm → layout px via a probe, so it tracks the browser's real DPI and
// ignores the zoom slider (that's a CSS transform, not a layout change).
function cmToPx(cm) {
  const probe = document.createElement("div");
  probe.style.cssText =
    `position:absolute;visibility:hidden;left:-9999px;top:0;width:1px;height:${cm}cm;`;
  document.body.appendChild(probe);
  const px = probe.offsetHeight;
  probe.remove();
  return px;
}

function paginate() {
  const P = cmToPx(PAGE_CM);
  const G = cmToPx(GUTTER_CM);
  const M = cmToPx(MARGIN_CM);
  const contentH = P - 2 * M;              // usable text height per page
  const blocks = Array.from(editor.children);
  if (!blocks.length) { renderSheets([{ top: 0, height: P }]); return; }

  // (1) Reset prior shifts, then read the natural layout in one pass.
  for (const b of blocks) b.style.marginTop = "";
  const tops = blocks.map((b) => b.offsetTop);
  const heights = blocks.map((b) => b.offsetHeight);
  const natMargin = blocks.map((b) => parseFloat(getComputedStyle(b).marginTop) || 0);

  // (2) Assign blocks to pages using natural (continuous) coordinates.
  const pageOf = new Array(blocks.length);
  let page = 0;
  let pageContentTop = tops[0];            // natural top of this page's first block
  for (let i = 0; i < blocks.length; i++) {
    const isFirst = tops[i] - pageContentTop <= 1;
    const overflow = tops[i] + heights[i] - pageContentTop > contentH + 1;
    if (overflow && !isFirst) {
      page += 1;
      pageContentTop = tops[i];
    }
    pageOf[i] = page;
    // A manual page break ends the current page; the next block starts fresh.
    if (blocks[i].classList.contains("page-break") && i + 1 < blocks.length) {
      page += 1;
      pageContentTop = tops[i + 1];
    }
  }
  const nPages = page + 1;

  // Per-page first/last block indices.
  const firstIdx = [], lastIdx = [];
  for (let i = 0; i < blocks.length; i++) {
    const p = pageOf[i];
    if (firstIdx[p] === undefined) firstIdx[p] = i;
    lastIdx[p] = i;
  }

  // (3) Compute each sheet's top (Y) and height, then shift page-leading blocks.
  const Y = [0], sheetH = [];
  for (let p = 0; p < nPages; p++) {
    const s = firstIdx[p], e = lastIdx[p];
    const pageContentH = tops[e] + heights[e] - tops[s];
    sheetH[p] = Math.max(P, pageContentH + 2 * M);   // grow only for oversized blocks
    if (p > 0) Y[p] = Y[p - 1] + sheetH[p - 1] + G;
  }
  let appliedShift = 0;
  for (let p = 1; p < nPages; p++) {
    const s = firstIdx[p];
    const delta = (Y[p] + M) - (tops[s] + appliedShift);
    if (delta) blocks[s].style.marginTop = (natMargin[s] + delta) + "px";
    appliedShift += delta;
  }

  // (4) Paint the sheets and size the editor to cover them.
  const rects = [];
  for (let p = 0; p < nPages; p++) rects.push({ top: Y[p], height: sheetH[p] });
  editor.style.minHeight = (Y[nPages - 1] + sheetH[nPages - 1]) + "px";
  renderSheets(rects);
  sizePageWrap();   // the page just changed height; the scroll area must follow
  const pc = $("#page-count");
  if (pc) pc.textContent = nPages === 1 ? "1 page" : `${nPages} pages`;
}

function renderSheets(rects) {
  backdrop.innerHTML = "";
  rects.forEach((r, i) => {
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.style.top = r.top + "px";
    sheet.style.height = r.height + "px";
    if (rects.length > 1) {
      const num = document.createElement("span");
      num.className = "sheet-num";
      num.textContent = String(i + 1);
      sheet.appendChild(num);
    }
    backdrop.appendChild(sheet);
  });
}

function insertPageBreak() {
  // A non-editable marker; paginate() forces the next block onto a new page.
  exec("insertHTML", '<div class="page-break" contenteditable="false"></div><p><br></p>');
}

// The editor's HTML for saving / sending to the AI, with pagination-only
// artifacts removed: the inline margin-top we inject to align pages, and the
// manual break markers (turned into a real page break the exporter understands).
function cleanDocHtml() {
  const clone = editor.cloneNode(true);
  clone.querySelectorAll("[style]").forEach((el) => {
    el.style.marginTop = "";
    if (!el.getAttribute("style")) el.removeAttribute("style");
  });
  clone.querySelectorAll(".page-break").forEach((el) => {
    const p = document.createElement("p");
    // Use the legacy property name literally — LibreOffice's HTML import
    // honours `page-break-after`, not the modern `break-after` alias that
    // el.style.pageBreakAfter would serialise to.
    p.setAttribute("style", "page-break-after: always");
    p.appendChild(document.createElement("br"));
    el.replaceWith(p);
  });
  return clone.innerHTML;
}

let pgRAF = 0;
function schedulePaginate() {
  cancelAnimationFrame(pgRAF);
  pgRAF = requestAnimationFrame(paginate);
}
editor.addEventListener("input", schedulePaginate);
window.addEventListener("resize", schedulePaginate);
// Re-flow once late-loading fonts settle (they change block heights).
window.addEventListener("load", schedulePaginate);
if (document.fonts?.ready) document.fonts.ready.then(schedulePaginate);

// ---------------------------------------------------------------------------
// AI pane: show / hide + draggable resize
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
$("#toggle-ai").classList.add("active"); // panel starts visible

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
  const app = $("#app").getBoundingClientRect();
  let w = app.right - e.clientX;
  w = Math.max(300, Math.min(w, app.width - 380)); // clamp both panes
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
  const res = await fetch("/api/models");
  const data = await res.json();
  modelSelect.innerHTML = "";
  data.models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label + (m.has_key ? "" : " ⚠");
    if (m.id === data.active) opt.selected = true;
    modelSelect.appendChild(opt);
  });
}
modelSelect.addEventListener("change", async () => {
  await fetch("/api/models/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: modelSelect.value }),
  });
  addSystemMessage(`Switched model to ${modelSelect.options[modelSelect.selectedIndex].text}`);
});

// -- Add-model modal --------------------------------------------------------
const mfApiType = $("#mf-api-type");   // wire protocol: anthropic | openai
const mfProvider = $("#mf-provider");  // free-text brand/provider name

// Placeholder presets per API type, plus show/hide the API-endpoint field
// (Anthropic uses a fixed endpoint, so it isn't asked for).
function applyProviderPreset() {
  const anthropic = mfApiType.value === "anthropic";
  $("#mf-baseurl-row").hidden = anthropic;
  $("#mf-model").placeholder = anthropic ? "e.g. claude-opus-4-8" : "e.g. gpt-4o  or  qwen2.5";
  $("#mf-api-key-env").placeholder = anthropic ? "e.g. ANTHROPIC_API_KEY" : "e.g. OPENAI_API_KEY";
  $("#mf-base-url").placeholder = "https://api.openai.com/v1  (or http://localhost:11434/v1)";
  // Offer a sensible default provider name without clobbering a custom one.
  if (anthropic && (!mfProvider.value || mfProvider.value === "OpenAI")) mfProvider.value = "Anthropic";
  if (!anthropic && mfProvider.value === "Anthropic") mfProvider.value = "";
}
mfApiType.addEventListener("change", applyProviderPreset);

async function openModelModal() {
  ["#mf-label", "#mf-model", "#mf-base-url", "#mf-api-key", "#mf-api-key-env", "#mf-id", "#mf-provider"]
    .forEach((s) => { $(s).value = ""; });
  mfApiType.value = "anthropic";
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

  const apiType = mfApiType.value;
  const provider = mfProvider.value.trim() || (apiType === "anthropic" ? "Anthropic" : "OpenAI");
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
    await fetch("/api/models/active", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    addSystemMessage(`Added and switched to model: ${label}`);
  } catch (e2) {
    showError("Could not add model: " + e2.message);
  } finally {
    submit.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
async function openSkills() {
  await renderSkills();
  $("#skills-modal").hidden = false;
}
async function renderSkills() {
  const res = await fetch("/api/skills");
  const data = await res.json();
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

// ---------------------------------------------------------------------------
// Conversation tabs (multiple independent AI chats)
// ---------------------------------------------------------------------------
const tabListEl = $("#tab-list");
const panelsEl = $("#tab-panels");
let sessions = [];      // { id, title, autoTitle, history: [], el: <div.messages> }
let activeId = null;
let seq = 0;

function activeSession() {
  return sessions.find((s) => s.id === activeId);
}
function activeMessagesEl() {
  return activeSession()?.el;
}

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
  if (activeId === id) {
    setActive(sessions[Math.max(0, idx - 1)].id);
  } else {
    renderTabs();
  }
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

$("#tab-add").addEventListener("click", () => createSession());

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener("click", send);

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

function fmtSecs(ms) {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

async function streamAssistant(session) {
  streaming = true;
  sendBtn.disabled = true;
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
      body: JSON.stringify({ messages: session.history, document_html: cleanDocHtml() }),
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
    bubble.innerHTML = `<span style="color:var(--accent)">Error: ${escapeHtml(err.message)}</span>`;
  } finally {
    streaming = false;
    sendBtn.disabled = false;
    session.el.scrollTop = session.el.scrollHeight;
  }
}

function finalizeAssistant(msg, bubble, full, state = {}) {
  const { text, doc } = stripDocBlock(full);
  const head = state.hadThinking || (state.reasonedMs || 0) > 1500
    ? `<div class="reasoned">💭 Reasoned for ${fmtSecs(state.reasonedMs || 0)}</div>`
    : "";
  bubble.innerHTML = head + renderMarkdown(text);
  if (doc != null) {
    const box = document.createElement("div");
    box.className = "doc-proposal";
    box.innerHTML = `
      <div class="dp-head"><span>Proposed document</span>
        <button class="apply-btn">Apply to document</button></div>
      <div class="dp-preview"></div>`;
    box.querySelector(".dp-preview").innerHTML = doc;
    const btn = box.querySelector(".apply-btn");
    btn.addEventListener("click", () => {
      replaceEditorContent(doc);
      btn.textContent = "Applied ✓";
      btn.classList.add("applied");
      btn.disabled = true;
    });
    msg.appendChild(box);
  }
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
  const doc = m[1].trim();
  const cleaned = text.replace(re, "").trim();
  return { text: cleaned, doc };
}

function addMessage(role, content, target = activeMessagesEl()) {
  const msg = document.createElement("div");
  msg.className = "msg " + role;
  const roleLabel = role === "user" ? "You" : role === "assistant" ? "Assistant" : "";
  msg.innerHTML = `${roleLabel ? `<span class="role">${roleLabel}</span>` : ""}<div class="bubble"></div>`;
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

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
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
      await fetch("/api/models/active", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: arg }),
      });
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

// ---------------------------------------------------------------------------
// Minimal markdown rendering (safe: escapes HTML first)
// ---------------------------------------------------------------------------
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
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
// Ctrl/Cmd+S saves in place instead of triggering the browser's Save-Page.
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    saveToFile();
  }
});

// Tab inserts one full-width space (U+3000) — exactly one CJK character wide —
// rather than moving focus out of the editor. execCommand keeps it undoable.
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    document.execCommand("insertText", false, "　");
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadModels();
updateWordCount();
paginate();
createSession();
addSystemMessage("Assistant ready. Type /help for commands.");
