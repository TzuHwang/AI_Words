r"""Compile LaTeX source to PDF.

Like the ODT converter's optional LibreOffice path, this shells out to a LaTeX
engine only if one is installed — the app runs fine without it (the LaTeX editor
just shows a "no compiler" notice instead of a preview).

`tectonic` is preferred: it's a single self-contained binary that fetches missing
packages on demand, so there's no multi-gigabyte TeX Live install to manage. It
also never runs `\write18` shell-escape, so compiling untrusted source is safe.
The classic engines are accepted as fallbacks, always with shell-escape disabled.

Compiles share one working directory for the life of the process. Keeping the
intermediates means a single engine pass can resolve cross references (`\ref`,
the table of contents, citations) from the previous run's `.aux` instead of
leaving them as `??`, and it saves the engine re-deriving them on every edit.
Only one compile runs at a time: a new one kills the compile still in flight,
so a burst of typing can't build up a backlog of stale runs.
"""

from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import tempfile
import threading

# Engines in preference order. Each entry is (name, argv-builder). The builder
# takes the source filename and output dir and returns the command to run.
_ENGINES = ("tectonic", "xelatex", "pdflatex", "lualatex")

# Hard ceiling on a single compile, so a runaway document (e.g. an infinite
# macro loop) can't hang the server.
_TIMEOUT_S = 60

# Returned as the log when a compile was killed because a newer one arrived.
# The caller answers 409 and the browser drops it: a superseded run is not an
# error, and its (absent) output is about to be replaced anyway.
SUPERSEDED = "__superseded__"

_work_dir: str | None = None            # shared build directory, created on demand
_running: subprocess.Popen | None = None  # the compile in flight, if any
_start_lock = threading.Lock()          # serialises "kill the old, start the new"


def find_tex() -> str | None:
    """Return a usable LaTeX engine path, or None if none is installed."""
    for name in _ENGINES:
        found = shutil.which(name)
        if found:
            return found
    return None


def _engine_argv(engine: str, src: str, out_dir: str) -> list[str]:
    name = os.path.splitext(os.path.basename(engine))[0].lower()
    if name == "tectonic":
        # Tectonic has no shell-escape and manages its own package fetching.
        # --keep-intermediates leaves the .aux behind for the next compile to
        # start from, so it needn't re-run a pass to converge.
        return [engine, "--outdir", out_dir, "--keep-logs", "--keep-intermediates", src]
    # TeX Live engines: run headless, never allow shell-escape.
    return [
        engine,
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-no-shell-escape",
        f"-output-directory={out_dir}",
        src,
    ]


def _build_dir() -> str:
    """Return the shared working directory, creating it on first use."""
    global _work_dir
    if _work_dir is None or not os.path.isdir(_work_dir):
        _work_dir = tempfile.mkdtemp(prefix="aiwords-tex-")
        atexit.register(shutil.rmtree, _work_dir, ignore_errors=True)
    return _work_dir


def _prime_aux(work: str) -> None:
    """Start the run from the last *complete* ``.aux``.

    A compile that was killed mid-run leaves a partial one behind, and reading
    that back would silently drop the cross references it hadn't reached yet.
    Other intermediates (.toc, .out) are regenerated from the .aux, so they heal
    on the following run by themselves.
    """
    aux, keep = os.path.join(work, "doc.aux"), os.path.join(work, "doc.aux.ok")
    if os.path.isfile(keep):
        shutil.copyfile(keep, aux)
    else:
        _remove(aux)


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def render_tex_to_pdf(source: str) -> tuple[bytes | None, str]:
    """Compile LaTeX ``source`` to PDF.

    Returns ``(pdf_bytes, log)``. On success ``pdf_bytes`` is the PDF and ``log``
    is the engine's stdout/stderr (kept for surfacing warnings). On failure
    ``pdf_bytes`` is None and ``log`` holds the compiler output to show the user,
    or ``SUPERSEDED`` if a newer compile took over.

    Blocking: run it off the event loop.
    """
    global _running
    engine = find_tex()
    if not engine:
        return None, "No LaTeX engine found. Install tectonic (recommended) or TeX Live."

    work = _build_dir()
    src = os.path.join(work, "doc.tex")
    pdf_path = os.path.join(work, "doc.pdf")

    with _start_lock:
        if _running and _running.poll() is None:
            _running.kill()             # the newest source is the only one worth compiling
            _running.wait()
        with open(src, "w", encoding="utf-8") as fh:
            fh.write(source)
        _prime_aux(work)
        # The directory outlives the run, so the previous PDF has to go: a
        # failed compile must not hand back stale output as a success.
        _remove(pdf_path)
        try:
            proc = subprocess.Popen(
                _engine_argv(engine, src, work),
                cwd=work,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            return None, f"Failed to run {engine}: {exc}"
        _running = proc

    try:
        out, err = proc.communicate(timeout=_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return None, f"Compilation timed out after {_TIMEOUT_S}s."

    with _start_lock:
        if _running is not proc:        # killed above by a newer compile
            return None, SUPERSEDED
        _running = None

    log = _decode(out) + _decode(err)
    if os.path.isfile(pdf_path):
        aux = os.path.join(work, "doc.aux")
        if os.path.isfile(aux):
            shutil.copyfile(aux, aux + ".ok")   # this one ran to completion
        with open(pdf_path, "rb") as fh:
            return fh.read(), log
    return None, log or f"{engine} produced no PDF (exit {proc.returncode})."


def _decode(raw: bytes) -> str:
    return raw.decode("utf-8", errors="replace") if raw else ""
