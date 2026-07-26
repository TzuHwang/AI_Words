"use strict";

// $ and the AI pane itself come from ui.js / ai-pane.js, loaded first.
const editor = $("#editor");
const docNameEl = $("#doc-name");

let docName = "Untitled";

// A writable handle to the file the document was opened from, when the File
// System Access API is available. Ctrl+S writes straight back to it; otherwise
// it's null and saving falls back to a Save-As picker or a download.
let fileHandle = null;
const supportsFsa = "showOpenFilePicker" in window;

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
const fontSelect = $("#font-select");
fontSelect.addEventListener("change", (e) => {
  exec("fontName", e.target.value);
});

// Reflect the selection's font in the dropdown: show the matching family when
// the selection is all one font, blank when it spans several (Office-style).
// Keyed on the *primary* (first) family name, normalised, so a reopened doc's
// single "新細明體" matches the dropdown's "新細明體, PMingLiU, serif" option.
const primaryFamily = (ff) =>
  (ff.split(",")[0] || "").trim().replace(/^["']|["']$/g, "").toLowerCase();
const fontKeyToValue = new Map();
Array.from(fontSelect.options).forEach((o) => {
  if (o.value) fontKeyToValue.set(primaryFamily(o.value), o.value);
});

// The distinct font families across the current selection (or caret), or null
// when the selection isn't inside the editor.
function selectionFontKeys() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  const keys = new Set();
  const addFontOf = (node) => {
    const el = node.nodeType === 3 ? node.parentElement : node;
    if (el) keys.add(primaryFamily(getComputedStyle(el).fontFamily));
  };
  if (range.collapsed) {
    addFontOf(range.startContainer);
  } else {
    const root = range.commonAncestorContainer;
    const base = root.nodeType === 3 ? root.parentNode : root;
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeValue && n.nodeValue.trim() && range.intersectsNode(n)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) addFontOf(n);
  }
  return [...keys];
}

function syncFontSelect() {
  const keys = selectionFontKeys();
  if (keys === null) return;                       // selection isn't in the editor
  if (keys.length === 1 && fontKeyToValue.has(keys[0])) {
    fontSelect.value = fontKeyToValue.get(keys[0]);
  } else {
    fontSelect.selectedIndex = -1;                 // blank: mixed or an unlisted font
  }
}
document.addEventListener("selectionchange", syncFontSelect);

// Remember the most recent non-empty selection made *inside* the editor, so the
// AI chat can send it as focus context even after focus moves to the chat box
// (which would otherwise collapse the document selection). Collapsing the
// selection inside the editor clears it; selecting elsewhere leaves it untouched.
let lastDocSelection = "";
let lastDocRange = null;
function docSelectionText() {
  return lastDocSelection;
}

// A persistent highlight that keeps the AI-focus text visible once the native
// selection is lost (e.g. when the chat box is focused). Falls back gracefully
// where the CSS Custom Highlight API is unavailable.
const focusHighlight = window.Highlight && CSS.highlights ? new Highlight() : null;
if (focusHighlight) CSS.highlights.set("ai-focus", focusHighlight);
function showFocusHighlight() {
  if (!focusHighlight) return;
  focusHighlight.clear();
  if (lastDocRange) focusHighlight.add(lastDocRange);
}
function clearFocusHighlight() {
  if (focusHighlight) focusHighlight.clear();
}

document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return; // e.g. the chat box
  if (range.collapsed) {
    lastDocSelection = "";
    lastDocRange = null;
  } else {
    lastDocSelection = sel.toString().trim();
    lastDocRange = range.cloneRange();
  }
  clearFocusHighlight(); // editor is active, so the native selection shows
});
// When the editor loses focus, redraw the selection as our own highlight; when
// it regains focus, hand back to the native selection.
editor.addEventListener("blur", showFocusHighlight);
editor.addEventListener("focus", clearFocusHighlight);

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
    case "home": location.href = "/"; break;
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

// Load a document handed off from the launcher (see launcher.js). It stashed
// already-converted HTML in sessionStorage; consume and clear it once. There's
// no writable file handle across the navigation, so Ctrl+S will Save-As.
function consumeHandoff() {
  const raw = sessionStorage.getItem("aiwords.pending");
  if (!raw) return;
  sessionStorage.removeItem("aiwords.pending");
  let pending;
  try { pending = JSON.parse(raw); } catch (_) { return; }
  if (!pending || pending.mode !== "richtext") return;
  editor.innerHTML = pending.content || "<p><br></p>";
  docName = (pending.filename || "Untitled").replace(/\.[^.]+$/, "");
  docNameEl.textContent = pending.filename || docName;
  updateWordCount();
  schedulePaginate();
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
// AI assistant
//
// The pane itself — conversation tabs, chat, slash commands, the models and
// skills panels, the resize divider — is ai-pane.js, shared with the LaTeX
// editor. Only what is specific to this editor stays here: what counts as "the
// document", and what applying a proposed one does.
// ---------------------------------------------------------------------------
AiPane.init({
  placeholder: "Ask about the document, or /help for commands…",
  getDocument: cleanDocHtml,
  getSelection: docSelectionText,
  proposal: {
    title: "Proposed document",
    applyLabel: "Apply to document",
    // The proposal is document HTML, so preview it rendered rather than raw.
    renderPreview: (doc) => {
      const el = document.createElement("div");
      el.className = "dp-preview";
      el.innerHTML = doc;
      return el;
    },
    apply: replaceEditorContent,
  },
});

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
consumeHandoff();
updateWordCount();
paginate();
