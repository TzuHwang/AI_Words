"use strict";

// Format chooser. "New" is just a link to /editor or /latex. "Open" reads the
// file here, routes by extension, and hands the loaded content to the target
// editor via sessionStorage (a file can't ride along in a navigation URL).
//
// Handoff contract — sessionStorage["aiwords.pending"] = JSON:
//   { mode: "richtext" | "latex", filename, content }
// where content is HTML (richtext) or .tex source (latex). The editor consumes
// and clears it on load.
const HANDOFF = "aiwords.pending";

const fileInput = document.getElementById("lc-file");
const openBtn = document.getElementById("lc-open");
const errEl = document.getElementById("lc-error");

openBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  errEl.hidden = true;
  openBtn.disabled = true;
  try {
    const ext = (file.name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
    if (ext === "tex") {
      // Plain text — no server conversion needed.
      const source = await file.text();
      stash({ mode: "latex", filename: file.name, content: source });
      location.href = "/latex";
    } else if (ext === "odt" || ext === "html" || ext === "htm") {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const data = await res.json();
      stash({ mode: "richtext", filename: data.filename || file.name, content: data.html || "" });
      location.href = "/editor";
    } else {
      throw new Error("Unsupported file type. Choose an .odt, .html, or .tex file.");
    }
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
    fileInput.value = "";
    openBtn.disabled = false;
  }
});

function stash(obj) {
  sessionStorage.setItem(HANDOFF, JSON.stringify(obj));
}
