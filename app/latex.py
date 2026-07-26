r"""Compile LaTeX source to PDF.

Like the ODT converter's optional LibreOffice path, this shells out to a LaTeX
engine only if one is installed — the app runs fine without it (the LaTeX editor
just shows a "no compiler" notice instead of a preview).

`tectonic` is preferred: it's a single self-contained binary that fetches missing
packages on demand, so there's no multi-gigabyte TeX Live install to manage. It
also never runs `\write18` shell-escape, so compiling untrusted source is safe.
The classic engines are accepted as fallbacks, always with shell-escape disabled.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

# Engines in preference order. Each entry is (name, argv-builder). The builder
# takes the source filename and output dir and returns the command to run.
_ENGINES = ("tectonic", "xelatex", "pdflatex", "lualatex")

# Hard ceiling on a single compile, so a runaway document (e.g. an infinite
# macro loop) can't hang the server.
_TIMEOUT_S = 60


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
        return [engine, "--outdir", out_dir, "--keep-logs", src]
    # TeX Live engines: run headless, never allow shell-escape.
    return [
        engine,
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-no-shell-escape",
        f"-output-directory={out_dir}",
        src,
    ]


def render_tex_to_pdf(source: str) -> tuple[bytes | None, str]:
    """Compile LaTeX ``source`` to PDF.

    Returns ``(pdf_bytes, log)``. On success ``pdf_bytes`` is the PDF and ``log``
    is the engine's stdout/stderr (kept for surfacing warnings). On failure
    ``pdf_bytes`` is None and ``log`` holds the compiler output to show the user.
    """
    engine = find_tex()
    if not engine:
        return None, "No LaTeX engine found. Install tectonic (recommended) or TeX Live."

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "doc.tex")
        with open(src, "w", encoding="utf-8") as fh:
            fh.write(source)
        try:
            proc = subprocess.run(
                _engine_argv(engine, src, tmp),
                cwd=tmp,
                capture_output=True,
                timeout=_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            return None, f"Compilation timed out after {_TIMEOUT_S}s."
        except OSError as exc:
            return None, f"Failed to run {engine}: {exc}"

        log = _decode(proc.stdout) + _decode(proc.stderr)
        pdf_path = os.path.join(tmp, "doc.pdf")
        if os.path.isfile(pdf_path):
            with open(pdf_path, "rb") as fh:
                return fh.read(), log
        return None, log or f"{engine} produced no PDF (exit {proc.returncode})."


def _decode(raw: bytes) -> str:
    return raw.decode("utf-8", errors="replace") if raw else ""
