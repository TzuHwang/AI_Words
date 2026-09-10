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
  syncToolbarState();
  schedulePaginate();
}

// ---------------------------------------------------------------------------
// Editor: inline / block formatting commands
// ---------------------------------------------------------------------------
function exec(cmd, value = null) {
  editor.focus();
  document.execCommand(cmd, false, value);
  updateWordCount();
  syncToolbarState();
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

// ---------------------------------------------------------------------------
// Toolbar pressed-states (LibreOffice-style): the alignment buttons and the
// format toggles (B/I/U/S, lists) reflect what the caret is in. Alignment is
// read off the computed style of the block(s) under the selection; the toggles
// come from queryCommandState.
// ---------------------------------------------------------------------------
const ALIGN_CMD_TO_VALUE = {
  justifyLeft: "left", justifyCenter: "center",
  justifyRight: "right", justifyFull: "justify",
};
const ALIGN_VALUE_TO_CMD = {
  left: "justifyLeft", center: "justifyCenter",
  right: "justifyRight", justify: "justifyFull",
};
const TOGGLE_CMDS = [
  "bold", "italic", "underline", "strikeThrough",
  "insertUnorderedList", "insertOrderedList",
];

// The text-align of the block(s) the current selection (or the last one made
// inside the editor) covers: a single shared value, or null for mixed/none.
function selectionBlockAlign() {
  const sel = window.getSelection();
  let range = null;
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    if (editor.contains(r.commonAncestorContainer)) range = r;
  }
  if (!range && lastDocRange && editor.contains(lastDocRange.commonAncestorContainer)) {
    range = lastDocRange;
  }
  if (!range) return null;

  const blockOf = (node) => {
    let el = node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== editor) {
      const display = getComputedStyle(el).display;
      if (display === "block" || display === "list-item") return el;
      el = el.parentElement;
    }
    return null;
  };
  const addAt = (node) => {
    const b = blockOf(node);
    if (!b) return;
    const value = getComputedStyle(b).textAlign;
    // The computed value of an unset alignment is "start"; treat it as left,
    // which is what an LTR document means by it.
    aligns.add(value === "start" ? "left" : value === "end" ? "right" : value);
  };
  const aligns = new Set();
  if (range.collapsed) {
    addAt(range.startContainer);
  } else {
    const root = range.commonAncestorContainer;
    const base = root.nodeType === 3 ? root.parentNode : root;
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeValue && n.nodeValue.trim() && range.intersectsNode(n)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) addAt(n);
  }
  if (aligns.size === 1) {
    const only = [...aligns][0];
    return only in ALIGN_VALUE_TO_CMD ? only : null;
  }
  return null;
}

function syncToolbarState() {
  const align = selectionBlockAlign();
  document.querySelectorAll(".lo-tb-btn[data-cmd]").forEach((btn) => {
    const cmd = btn.dataset.cmd;
    let on = false;
    if (cmd in ALIGN_CMD_TO_VALUE) {
      on = align !== null && ALIGN_CMD_TO_VALUE[cmd] === align;
    } else if (TOGGLE_CMDS.includes(cmd)) {
      try { on = document.queryCommandState(cmd); } catch (_) { on = false; }
    }
    btn.classList.toggle("active", on);
  });
}
document.addEventListener("selectionchange", syncToolbarState);

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
  updateWordCount();     // the status bar counts the selection while there is one
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
    case "insert-image": insertImage(); break;
    case "insert-table": insertTable(); break;
    case "insert-link": insertLink(); break;
    case "insert-symbol": insertSymbol(); break;
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

// Insert an image chosen from disk, stored inline as a data: URL so the whole
// document stays a single self-contained HTML fragment the converter can embed
// into the ODT. Sizes it down to the text column width, preserving aspect.
let imageInput = null;
const IMAGE_MAX_WIDTH = 600;  // px, close to the A4 text column at 96dpi

async function insertImage() {
  if (!imageInput) {
    imageInput = document.createElement("input");
    imageInput.type = "file";
    imageInput.accept = "image/*";
  }
  const picked = new Promise((resolve) => {
    imageInput.onchange = () => {
      const file = imageInput.files && imageInput.files[0];
      imageInput.value = "";
      resolve(file || null);
    };
    imageInput.oncancel = () => resolve(null);
    imageInput.click();
  });
  const file = await picked;
  if (!file) return;

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const size = await new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => resolve(null);
    probe.src = dataUrl;
  });

  let { width, height } = size || { width: IMAGE_MAX_WIDTH, height: IMAGE_MAX_WIDTH };
  if (width > IMAGE_MAX_WIDTH) {
    height = Math.round((height * IMAGE_MAX_WIDTH) / width);
    width = IMAGE_MAX_WIDTH;
  }
  exec("insertHTML",
    `<img src="${dataUrl}" style="width: ${width}px; height: ${height}px;" alt="">`);
}

// ---------------------------------------------------------------------------
// Special characters — the grid itself is uiSymbolPicker (ui.js); what belongs
// to this editor is the table and getting the character to the caret. The dialog
// steals focus, so the caret is carried by hand: captured when the picker opens
// and re-captured after every insertion, so the next one lands after the last.
// ---------------------------------------------------------------------------
const SYMBOL_GROUPS = [
  ["中文標點", `，、。．：；？！‧…—－～「」『』（）〔〕［］｛｝【】〖〗《》〈〉〝〞︿﹀`],
  ["Punctuation", `.,;:?!'"‘’“”‹›«»–—…·•§¶†‡*/\\&@#%‰°′″`],
  ["Math", `+−±×÷=≠≈≡<>≤≥∞√∑∏∫∂∆∇∈∉⊂⊃∪∩∴∵∠⊥∥`],
  ["Arrows", `←→↑↓↔↕⇐⇒⇑⇓⇔↵`],
  ["Greek", `αβγδεζηθλμνξπρστφχψωΓΔΘΛΞΠΣΦΨΩ`],
  ["Symbols", `$¢£¥€₩©®™℃℉№✓✗★☆◆●○■□▲▼♪♥`],
];

// The caret (or selection) inside the editor, if that's where it currently is.
function editorRange() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

function insertSymbol() {
  let caret = editorRange();
  uiSymbolPicker(SYMBOL_GROUPS, (text) => {
    editor.focus();
    const sel = window.getSelection();
    if (caret) { sel.removeAllRanges(); sel.addRange(caret); }
    document.execCommand("insertText", false, text);
    caret = editorRange();       // insert the next one after this character
    updateWordCount();
    schedulePaginate();
  });
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
//
// The count follows the selection the AI pane also treats as focus, so it keeps
// showing the selection after focus moves to the chat box, just like the
// highlight does; with no selection it counts the whole document.
//
// CJK is written without spaces, so splitting on whitespace would count a whole
// sentence as one word: each CJK character counts as a word of its own, and the
// rest of the text counts runs of letters and digits, with punctuation between
// them separating rather than counting.
// ---------------------------------------------------------------------------
// Kana and CJK ideographs (incl. extension A and compatibility). Korean is
// spaced like English, so it needs no special case and isn't listed here.
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

function countWords(text) {
  const cjk = (text.match(CJK_CHAR) || []).length;
  return cjk + (text.replace(CJK_CHAR, " ").match(WORD) || []).length;
}

function updateWordCount() {
  const total = countWords(editor.textContent);
  const plural = total === 1 ? "1 word" : `${total} words`;
  $("#word-count").textContent = lastDocSelection
    ? `${countWords(lastDocSelection)} of ${plural}`
    : plural;
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

// ---------------------------------------------------------------------------
// Paragraph splitting (cross-page continuation)
//
// A paragraph that runs past the bottom of a page is split at a *line* boundary
// into two sibling blocks that share one logical paragraph: the continuation
// carries `data-cont-of` -> the origin block's id. Every paginate first merges
// the continuations back (so the document is its logical form), then re-splits
// for the current layout. A paragraph taller than a page chains continuations.
// ---------------------------------------------------------------------------
let _paraSeq = 0;

function remergeContinuations(root) {
  let changed = false;
  let mergedAny = false;
  let cont = root.querySelector("[data-cont-of]");
  while (cont) {
    const prev = cont.previousElementSibling;
    if (prev && prev.id === cont.getAttribute("data-cont-of")
        && prev.tagName === cont.tagName) {
      while (cont.firstChild) prev.appendChild(cont.firstChild);
      cont.remove();
      changed = true;
      mergedAny = true;
    } else {
      // The user edited around the break; stop treating it as a continuation.
      cont.removeAttribute("data-cont-of");
      cont.classList.remove("para-cont");
      changed = true;
    }
    cont = root.querySelector("[data-cont-of]");
  }
  if (mergedAny) _normalizeInlines(root);
  return changed;
}

// A split keeps the run open on both sides, so re-merging lands two adjacent
// identical inline elements (e.g. <strong>…</strong><strong>…</strong>) next to
// each other; the next split/merge cycle would duplicate it again. Fold those
// back together (and adjacent text nodes) so the paragraph stays canonical.
function _normalizeInlines(root) {
  const INLINE = new Set(["STRONG", "B", "EM", "I", "U", "SPAN", "A"]);
  const mergeChildren = (node) => {
    let prev = null;
    let child = node.firstChild;
    while (child) {
      const next = child.nextSibling;
      const bothText = prev && prev.nodeType === 3 && child.nodeType === 3;
      const bothInline = prev && prev.nodeType === 1 && child.nodeType === 1
        && prev.tagName === child.tagName && INLINE.has(prev.tagName)
        && prev.getAttribute("style") === child.getAttribute("style")
        && prev.getAttribute("href") === child.getAttribute("href")
        && prev.getAttribute("class") === child.getAttribute("class");
      if (bothText || bothInline) {
        if (bothText) prev.nodeValue += child.nodeValue;
        else while (child.firstChild) prev.appendChild(child.firstChild);
        child.remove();
        child = next;
        continue;   // keep prev, re-check against the new next
      }
      prev = child;
      child = next;
    }
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const elements = [root];
  while (walker.nextNode()) elements.push(walker.currentNode);
  for (const el of elements) mergeChildren(el);
}

function _collectText(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
    total += walker.currentNode.nodeValue.length;
  }
  return { nodes, total };
}

function _textPointAt(nodes, offset) {
  for (const node of nodes) {
    const len = node.nodeValue.length;
    if (offset <= len) return { node, off: offset };
    offset -= len;
  }
  const last = nodes[nodes.length - 1];
  return { node: last, off: last.nodeValue.length };
}

// A rect bottom, converted from viewport px back to the layout px the pagination
// measures in (offsetTop lives in layout px; the zoom transform only affects
// viewport coords). The canvas's own top padding is un-scaled, so it has to be
// removed before dividing by the zoom factor.
function _rectLayoutBottom(rect) {
  const canvasRect = canvas.getBoundingClientRect();
  const padTop = parseFloat(getComputedStyle(canvas).paddingTop) || 0;
  return (rect.bottom - canvasRect.top - padTop + canvas.scrollTop) / zoom;
}

// Distinct line-box bottoms a range spans, ascending. `getClientRects()` can
// report the same line once per inline element (e.g. the font <span> a paragraph
// is wrapped in), which would double the count and defeat orphan control, so
// they are deduplicated here.
function _lineBottoms(range) {
  const set = new Set();
  for (const r of range.getClientRects()) set.add(Math.round(_rectLayoutBottom(r)));
  return [...set].sort((a, b) => a - b);
}

function splitParagraph(block, maxBottom) {
  const tag = block.tagName;
  if (tag !== "P" && !/^H[1-6]$/.test(tag)) return false;
  if (block.querySelector("img, table")) return false;   // unsplittable content
  const text = _collectText(block);
  if (text.total === 0) return false;

  // Measure the block's line boxes and count how many still fit above
  // `maxBottom`. Line boxes are reliable where a collapsed caret is not — a
  // caret at a line-start boundary can report the *previous* line's bottom,
  // which used to leave one extra (clipped) line on the page.
  const whole = document.createRange();
  whole.selectNodeContents(block);
  const bottoms = _lineBottoms(whole);
  if (!bottoms.length) return false;
  let fit = bottoms.findIndex((b) => b > maxBottom);
  if (fit === -1) return false;   // the whole block fits
  if (fit === 0) return false;    // not even the first line fits

  // Orphan/widow control: a continuation of a single dangling line reads as a
  // mistake (and can split a compound word across the page). When only one line
  // would spill over, move the break one line earlier so the next page keeps
  // two lines — matching LibreOffice's default "no orphans" behaviour.
  if (bottoms.length - fit < 2 && fit >= 2) fit -= 1;

  // The split point is the first character of line `fit` (the first line that
  // does not fit). Find it as the smallest offset whose prefix spans more than
  // `fit` lines, minus one.
  const linesUpTo = (offset) => {
    const pt = _textPointAt(text.nodes, offset);
    const range = document.createRange();
    range.setStart(block, 0);
    range.setEnd(pt.node, pt.off);
    return _lineBottoms(range).length;
  };
  let lo = 1, hi = text.total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (linesUpTo(mid) <= fit) lo = mid + 1;
    else hi = mid;
  }
  const splitOffset = lo - 1;
  if (splitOffset <= 0 || splitOffset >= text.total) return false;

  if (!block.id) block.id = "para-" + (++_paraSeq);
  const originId = block.getAttribute("data-cont-of") || block.id;
  const pt = _textPointAt(text.nodes, splitOffset);

  const range = document.createRange();
  range.setStart(pt.node, pt.off);
  range.setEnd(block, block.childNodes.length);
  const frag = range.extractContents();

  const cont = document.createElement(tag.toLowerCase());
  if (block.getAttribute("class")) cont.setAttribute("class", block.getAttribute("class"));
  cont.classList.add("para-cont");
  if (block.getAttribute("style")) cont.setAttribute("style", block.getAttribute("style"));
  cont.setAttribute("data-cont-of", originId);
  cont.appendChild(frag);
  block.insertAdjacentElement("afterend", cont);
  return true;
}

// -- caret preservation across a merge/split --------------------------------
function _pointOffset(node, off) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let offset = 0, n;
  while ((n = walker.nextNode())) {
    if (n === node) return offset + off;
    offset += n.nodeValue.length;
  }
  return offset;
}

function editorSelectionOffsets() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  return {
    start: _pointOffset(range.startContainer, range.startOffset),
    end: _pointOffset(range.endContainer, range.endOffset),
  };
}

function _offsetPoint(target) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let offset = 0, n, last = null;
  while ((n = walker.nextNode())) {
    last = n;
    const len = n.nodeValue.length;
    if (target <= offset + len) return { node: n, off: target - offset };
    offset += len;
  }
  if (!last) return null;
  return { node: last, off: last.nodeValue.length };
}

function restoreSelection(offs) {
  if (!offs) return;
  const start = _offsetPoint(offs.start);
  const end = _offsetPoint(offs.end);
  if (!start || !end) return;
  const range = document.createRange();
  range.setStart(start.node, start.off);
  range.setEnd(end.node, end.off);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function splitPass(contentH, page0ContentTop) {
  // Walk the live blocks, splitting any paragraph/heading that runs past its
  // page's text area so the overflow continues on the next sheet. Returns
  // whether the DOM changed.
  //
  // Two coordinates are tracked: `pageFirstTop` (the natural top of the page's
  // first block — for deciding which block "starts" the page) and
  // `pageContentTop` (the natural top of the page's *text area* — for the
  // overflow/split budget). They differ on the first page, whose leading block
  // keeps its own top margin above the page's top margin.
  let changed = false;
  const kids = editor.children;
  if (!kids.length) return false;
  let pageFirstTop = kids[0].offsetTop;
  let pageContentTop = page0ContentTop;
  for (let i = 0; i < kids.length; i++) {
    const b = kids[i];
    const top = b.offsetTop, height = b.offsetHeight;
    const isFirst = Math.abs(top - pageFirstTop) <= 1;
    const overflow = top + height - pageContentTop > contentH + 1;
    if (overflow) {
      if (splitParagraph(b, pageContentTop + contentH)) {
        // b now ends on this page; the continuation it spawned starts the next.
        changed = true;
        pageFirstTop = b.nextElementSibling.offsetTop;
        pageContentTop = pageFirstTop;
        continue;
      }
      if (!isFirst) {
        // No line of this block fits on the current page (or it's unsplittable):
        // start a new page at its top and re-check it against that page — a
        // long paragraph that begins below the current page's bottom must still
        // be split on the page it lands on, not skipped whole.
        pageFirstTop = top;
        pageContentTop = top;
        continue;
      }
    }
    if (b.classList.contains("page-break") && b.nextElementSibling) {
      pageFirstTop = b.nextElementSibling.offsetTop;
      pageContentTop = pageFirstTop;
    }
  }
  return changed;
}

function paginate() {
  const P = cmToPx(PAGE_CM);
  const G = cmToPx(GUTTER_CM);
  const M = cmToPx(MARGIN_CM);
  const contentH = P - 2 * M;              // usable text height per page

  // Reset prior shifts, then bring the document back to its logical form and
  // split it afresh for this layout. The caret is pinned across the two so a
  // split can't throw it to the top of the page.
  for (const b of editor.children) b.style.marginTop = "";
  const saved = editorSelectionOffsets();
  // Both must run every time (re-merge the previous split, then re-split for
  // the current layout) — a short-circuit here would skip re-splitting right
  // after a merge and make the pagination oscillate between two layouts.
  const merged = remergeContinuations(editor);
  const split = splitPass(contentH, M);
  const changed = merged || split;

  const blocks = Array.from(editor.children);
  if (!blocks.length) {
    if (changed) restoreSelection(saved);
    renderSheets([{ top: 0, height: P }]);
    return;
  }

  // (1) Read the natural layout in one pass.
  const tops = blocks.map((b) => b.offsetTop);
  const heights = blocks.map((b) => b.offsetHeight);
  const natMargin = blocks.map((b) => parseFloat(getComputedStyle(b).marginTop) || 0);

  // (2) Assign blocks to pages using natural (continuous) coordinates. This
  // mirrors splitPass's page-boundary logic (page 0's text area starts at the
  // top margin M, later pages start at their leading block) so the two passes
  // agree on where every page ends.
  const pageOf = new Array(blocks.length);
  let page = 0;
  let pageFirstTop = tops[0];
  let pageContentTop = M;
  for (let i = 0; i < blocks.length; i++) {
    const isFirst = tops[i] - pageFirstTop <= 1;
    const overflow = tops[i] + heights[i] - pageContentTop > contentH + 1;
    if (overflow && !isFirst) {
      page += 1;
      pageFirstTop = tops[i];
      pageContentTop = tops[i];
    }
    pageOf[i] = page;
    // A manual page break ends the current page; the next block starts fresh.
    if (blocks[i].classList.contains("page-break") && i + 1 < blocks.length) {
      page += 1;
      pageFirstTop = tops[i + 1];
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
  if (changed) restoreSelection(saved);
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
  // Fold any cross-page continuations back into their logical paragraph, so the
  // saved document (and what the AI sees) has one paragraph, not page fragments.
  remergeContinuations(clone);
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
    // A block here is one top-level element of the document body — the unit the
    // pane walks the user through when reviewing a proposal. Whitespace between
    // block elements carries no meaning in HTML, so rejoining with newlines
    // gives back an equivalent document.
    splitBlocks: (doc) => {
      const holder = document.createElement("div");
      holder.innerHTML = doc;
      return [...holder.childNodes]
        .map((n) => (n.nodeType === 1 ? n.outerHTML : n.textContent.trim()))
        .filter(Boolean);
    },
    joinBlocks: (blocks) => blocks.join("\n"),
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

// Alignment shortcuts (LibreOffice keeps Ctrl+L/E/R/J; browsers reserve most
// of those for chrome, so Ctrl/Cmd+Shift+L/E and Ctrl/Cmd+Alt+L/E/R/J are the
// dependable spellings — plain Ctrl+L/E/R/J is honoured where the browser
// delivers it). Ignored while the focus is in an input/textarea/select so they
// never fire while typing in the AI chat.
const ALIGN_KEYS = {
  l: "justifyLeft", e: "justifyCenter", r: "justifyRight", j: "justifyFull",
};
window.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl || e.repeat) return;
  const k = (e.key || "").toLowerCase();
  if (!(k in ALIGN_KEYS)) return;
  // Only from the document itself (or page chrome like <body>): never while an
  // input/textarea/select — e.g. the AI chat box — has focus.
  const target = e.target;
  if (target && target !== document.body && target.isContentEditable !== true) return;
  const shift = e.shiftKey, alt = e.altKey, meta = e.metaKey;
  const ctrlOnly = ctrl && !shift && !alt;                 // plain Ctrl/Cmd+key
  const shiftLeft = shift && !alt && (k === "l" || k === "e" || k === "j");
  const altAny = alt && !shift;                            // Ctrl/Cmd+Alt+key
  const exclusive = ctrlOnly || shiftLeft || altAny;
  if (!exclusive || (ctrl && meta)) return;                // keep it unambiguous
  const anchor = window.getSelection()?.anchorNode;
  if (!editor.contains(anchor)) return;
  e.preventDefault();
  e.stopPropagation();
  exec(ALIGN_KEYS[k]);
});

// Tab inserts one full-width space (U+3000) — exactly one CJK character wide —
// rather than moving focus out of the editor. execCommand keeps it undoable.
// Ctrl/Cmd+Enter inserts a page break, matching LibreOffice Writer.
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    document.execCommand("insertText", false, "　");
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    insertPageBreak();
  }
});
// Keep the toolbar pressed-states fresh after typing/clicking inside the doc,
// not just when the selection changes.
editor.addEventListener("keyup", syncToolbarState);
editor.addEventListener("mouseup", syncToolbarState);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
consumeHandoff();
updateWordCount();
syncToolbarState();
paginate();
