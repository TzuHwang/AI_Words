"""Tests for app.latex — engine detection and the compile wrapper.

No LaTeX engine is required: detection is monkeypatched and the subprocess call
is stubbed, so these exercise the wrapper's branching (no engine, success,
failure, timeout) without a real TeX install.
"""

from __future__ import annotations

import subprocess

import pytest

from app import latex


def test_find_tex_prefers_first_available(monkeypatch):
    seen = {}

    def fake_which(name):
        seen.setdefault("order", []).append(name)
        return "/usr/bin/xelatex" if name == "xelatex" else None

    monkeypatch.setattr(latex.shutil, "which", fake_which)
    assert latex.find_tex() == "/usr/bin/xelatex"
    # tectonic is probed before xelatex (preference order).
    assert seen["order"][0] == "tectonic"


def test_render_without_engine(monkeypatch):
    monkeypatch.setattr(latex, "find_tex", lambda: None)
    pdf, log = latex.render_tex_to_pdf("anything")
    assert pdf is None
    assert "No LaTeX engine" in log


def test_engine_argv_disables_shell_escape():
    argv = latex._engine_argv("/usr/bin/pdflatex", "doc.tex", "/out")
    assert "-no-shell-escape" in argv
    # tectonic gets its own flag set (no shell-escape flag needed — it has none).
    tec = latex._engine_argv("/usr/bin/tectonic", "doc.tex", "/out")
    assert tec[0] == "/usr/bin/tectonic" and "--outdir" in tec


def test_render_success(monkeypatch, tmp_path):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/tectonic")

    def fake_run(argv, cwd, capture_output, timeout):
        # Emulate the engine writing doc.pdf into the temp cwd.
        with open(f"{cwd}/doc.pdf", "wb") as fh:
            fh.write(b"%PDF-1.5 stub")
        return subprocess.CompletedProcess(argv, 0, stdout=b"ok", stderr=b"")

    monkeypatch.setattr(latex.subprocess, "run", fake_run)
    pdf, log = latex.render_tex_to_pdf(r"\documentclass{article}\begin{document}Hi\end{document}")
    assert pdf == b"%PDF-1.5 stub"
    assert "ok" in log


def test_render_failure_returns_log(monkeypatch):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/pdflatex")

    def fake_run(argv, cwd, capture_output, timeout):
        return subprocess.CompletedProcess(argv, 1, stdout=b"! Undefined control sequence.", stderr=b"")

    monkeypatch.setattr(latex.subprocess, "run", fake_run)
    pdf, log = latex.render_tex_to_pdf(r"\bad")
    assert pdf is None
    assert "Undefined control sequence" in log


def test_render_timeout(monkeypatch):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/pdflatex")

    def fake_run(argv, cwd, capture_output, timeout):
        raise subprocess.TimeoutExpired(argv, timeout)

    monkeypatch.setattr(latex.subprocess, "run", fake_run)
    pdf, log = latex.render_tex_to_pdf("loop")
    assert pdf is None
    assert "timed out" in log.lower()
