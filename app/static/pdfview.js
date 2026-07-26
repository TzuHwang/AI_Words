"use strict";

// PDF viewer tab for the LaTeX editor.
//
// The editor tab posts compiled PDFs here as ArrayBuffers; pages are drawn with
// pdf.js into per-page canvases. A re-compile keeps the scroll position and the
// zoom level, and each page's new canvas replaces the old one only after it has
// finished painting — so an auto-compile lands without any visible flash.

import * as pdfjs from "/static/vendor/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.mjs";

const $ = (sel) => document.querySelector(sel);
const pagesEl = $("#pv-pages");
const emptyEl = $("#pv-empty");
const zoomEl = $("#pv-zoom");
const fitBtn = $("#pv-fit");
const nameEl = $("#pv-name");
const stampEl = $("#pv-stamp");

const DPR = window.devicePixelRatio || 1;
const PAGE_GAP = 48;          // horizontal breathing room used by "fit width"

let doc = null;               // current PDFDocumentProxy
let zoom = 1;
let fitWidth = true;
let generation = 0;           // bumped per document; stale renders are dropped
const boxes = [];             // one .pv-page element per page, in order
const inFlight = new Set();   // live RenderTasks, so superseded ones can be stopped

// Painting happens on the main thread, so a render left running after its
// output stopped being wanted steals time from the one that replaced it. With
// auto-compile arriving every second or so that piles up; cancelling makes
// pdf.js abandon the task instead of finishing a canvas nobody will see.
function cancelRenders() {
  for (const task of inFlight) task.cancel();
  inFlight.clear();
}

// Render a page when it comes near the viewport, not before.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    e.target.dataset.near = e.isIntersecting ? "1" : "";
    if (e.isIntersecting && e.target.dataset.stale) renderBox(e.target, generation);
  }
}, { root: pagesEl, rootMargin: "150% 0px" });

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
async function setPdf(data) {
  const gen = ++generation;
  cancelRenders();              // free the main thread for the parse below
  let next;
  try {
    next = await pdfjs.getDocument({ data }).promise;
  } catch (err) {
    stampEl.textContent = "Load failed";
    return;
  }
  if (gen !== generation) { next.destroy(); return; }
  const previous = doc;
  doc = next;
  emptyEl.hidden = true;
  await layout(gen);
  previous?.destroy();
}

// Size one box per page at the current zoom and mark them for re-render. Boxes
// keep their pixel size across compiles, so scrollTop stays meaningful.
async function layout(gen) {
  cancelRenders();              // whatever is being painted is about to be resized
  const n = doc.numPages;
  // Ask for every page at once: sizing is one await instead of N worker
  // round-trips, so the first page starts painting that much sooner.
  const pages = await Promise.all(
    Array.from({ length: n }, (_, i) => doc.getPage(i + 1)));
  if (gen !== generation) return;
  if (fitWidth) {
    zoom = Math.max(0.1, (pagesEl.clientWidth - PAGE_GAP) / pages[0].getViewport({ scale: 1 }).width);
  }
  zoomEl.textContent = Math.round(zoom * 100) + "%";

  pages.forEach((page, i) => {
    const vp = page.getViewport({ scale: zoom });
    const box = boxes[i] || addBox(i + 1);
    box.style.width = Math.floor(vp.width) + "px";
    box.style.height = Math.floor(vp.height) + "px";
    box.dataset.stale = "1";
  });
  while (boxes.length > n) {
    const box = boxes.pop();
    io.unobserve(box);
    box.remove();
  }

  for (const box of boxes) {
    if (box.dataset.near && box.dataset.stale) renderBox(box, gen);
  }
}

function addBox(num) {
  const box = document.createElement("div");
  box.className = "pv-page";
  box.dataset.page = String(num);
  pagesEl.appendChild(box);
  boxes.push(box);
  io.observe(box);
  return box;
}

async function renderBox(box, gen) {
  delete box.dataset.stale;                    // claim it before awaiting
  const page = await doc.getPage(Number(box.dataset.page));
  if (gen !== generation) return;
  const vp = page.getViewport({ scale: zoom * DPR });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const task = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp });
  inFlight.add(task);
  try {
    await task.promise;
  } catch (err) {
    return;                                    // cancelled, superseded, or page gone
  } finally {
    inFlight.delete(task);
  }
  if (gen !== generation) return;
  box.replaceChildren(canvas);                 // swap only once it is painted
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
function setZoom(next, fit) {
  fitWidth = fit;
  fitBtn.classList.toggle("active", fit);
  if (!fit) zoom = Math.min(5, Math.max(0.25, next));
  if (!doc) { zoomEl.textContent = Math.round(zoom * 100) + "%"; return; }
  const anchor = pagesEl.scrollTop / Math.max(1, pagesEl.scrollHeight);
  layout(generation).then(() => { pagesEl.scrollTop = anchor * pagesEl.scrollHeight; });
}

document.addEventListener("click", (e) => {
  switch (e.target.closest("[data-act]")?.dataset.act) {
    case "zoom-in": setZoom(zoom * 1.25, false); break;
    case "zoom-out": setZoom(zoom / 1.25, false); break;
    case "fit": setZoom(zoom, true); break;
  }
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  if (!fitWidth || !doc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => setZoom(zoom, true), 150);
});

// ---------------------------------------------------------------------------
// Link with the editor tab
// ---------------------------------------------------------------------------
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  const msg = e.data;
  if (!msg || msg.from !== "aiwords" || msg.type !== "pdf") return;
  nameEl.textContent = msg.name || "";
  stampEl.textContent = "Updated " + new Date().toLocaleTimeString();
  setPdf(msg.data);
});

fitBtn.classList.add("active");
// Ask for the current PDF; the editor answers with one if it has compiled.
window.opener?.postMessage({ from: "aiwords-pdfview", type: "ready" }, location.origin);
