"use strict";

// Helpers shared by every page. Loaded as a plain script before the page's own
// script, so these are globals: a page must not re-declare them (two top-level
// `const $` in classic scripts is a redeclaration error, not a shadow).

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

// ---------------------------------------------------------------------------
// Special-character picker — a click-to-insert grid of the punctuation and
// symbols that aren't on the keyboard. Each page brings its own table and its
// own way of inserting at the caret, because what belongs in the document
// differs: a character in the rich-text editor, usually a command in LaTeX.
//
//   groups: [[title, items], …] — items is a string of characters, or an array
//           whose entries are a character or a [shown, inserted] pair.
//   insert(text): called on every click. The dialog stays open, so several
//           characters can be inserted in a row.
// ---------------------------------------------------------------------------
function uiSymbolPicker(groups, insert) {
  const attr = (s) => escapeHtml(s).replace(/"/g, "&quot;");
  // The text each button inserts, kept out of the markup so nothing has to
  // survive a round trip through an attribute.
  const payloads = [];

  const body = groups.map(([title, items]) => {
    const entries = (typeof items === "string" ? [...items] : items)
      .map((it) => (Array.isArray(it) ? it : [it, it]));
    const cells = entries.map(([shown, inserted]) => {
      // A plain character has nothing to say about itself beyond its code point;
      // a command is worth spelling out.
      const tip = shown === inserted
        ? "U+" + shown.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")
        : inserted;
      payloads.push(inserted);
      return `<button class="sym-btn" data-i="${payloads.length - 1}"` +
        ` title="${attr(tip)}">${escapeHtml(shown)}</button>`;
    });
    return `<div class="sym-group"><div class="sym-title">${escapeHtml(title)}</div>` +
      `<div class="sym-grid">${cells.join("")}</div></div>`;
  });

  const overlay = document.createElement("div");
  overlay.className = "modal sym-overlay";
  overlay.innerHTML =
    `<div class="modal-box sym-box">` +
    `<div class="modal-head"><h3>Special Character</h3>` +
    `<button class="sym-close" title="Close">✕</button></div>` +
    body.join("") +
    `</div>`;

  overlay.addEventListener("click", (e) => {
    const btn = e.target.closest(".sym-btn");
    if (btn) { insert(payloads[+btn.dataset.i]); return; }
    // The close button, or the dark backdrop, dismisses.
    if (e.target.closest(".sym-close") || e.target === overlay) overlay.remove();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); overlay.remove(); }
  });
  document.body.appendChild(overlay);
  overlay.querySelector(".sym-close").focus();
}
