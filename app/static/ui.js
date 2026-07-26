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
