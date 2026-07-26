"""Tests for app.latex — engine detection and the compile wrapper.

No LaTeX engine is required: detection is monkeypatched and the subprocess is
stubbed, so these exercise the wrapper's branching (no engine, success, failure,
timeout, superseded) and its reuse of the shared build directory without a real
TeX install.
"""

from __future__ import annotations

import subprocess

import pytest

from app import latex


@pytest.fixture(autouse=True)
def isolated_build_dir(tmp_path, monkeypatch):
    """Point the module's shared state at a fresh dir for every test."""
    monkeypatch.setattr(latex, "_work_dir", str(tmp_path))
    monkeypatch.setattr(latex, "_running", None)
    return tmp_path


def fake_popen(behaviour, returncode=0, stdout=b"", stderr=b""):
    """A Popen stub. ``behaviour(cwd)`` runs in place of the engine."""

    class Proc:
        def __init__(self, argv, cwd=None, stdout=None, stderr=None):
            self.argv, self.cwd, self.returncode = argv, cwd, returncode
            self.killed = False

        def communicate(self, timeout=None):
            behaviour(self.cwd)
            return stdout, stderr

        def poll(self):
            return self.returncode if self.killed else None

        def kill(self):
            self.killed = True

        def wait(self):
            return self.returncode

    return Proc


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
    # tectonic gets its own flag set (no shell-escape flag needed — it has none)
    # and keeps intermediates so the next compile can reuse them.
    tec = latex._engine_argv("/usr/bin/tectonic", "doc.tex", "/out")
    assert tec[0] == "/usr/bin/tectonic" and "--outdir" in tec
    assert "--keep-intermediates" in tec


def test_render_success(monkeypatch):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/tectonic")
    monkeypatch.setattr(latex.subprocess, "Popen",
                        fake_popen(lambda cwd: _write(cwd, "doc.pdf", b"%PDF-1.5 stub"),
                                   stdout=b"ok"))
    pdf, log = latex.render_tex_to_pdf(r"\documentclass{article}\begin{document}Hi\end{document}")
    assert pdf == b"%PDF-1.5 stub"
    assert "ok" in log


def test_render_failure_returns_log(monkeypatch):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/pdflatex")
    monkeypatch.setattr(latex.subprocess, "Popen",
                        fake_popen(lambda cwd: None, returncode=1,
                                   stdout=b"! Undefined control sequence."))
    pdf, log = latex.render_tex_to_pdf(r"\bad")
    assert pdf is None
    assert "Undefined control sequence" in log


def test_render_timeout(monkeypatch):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/pdflatex")

    class Proc:
        def __init__(self, argv, cwd=None, stdout=None, stderr=None):
            self.returncode = None
            self.calls = 0

        def communicate(self, timeout=None):
            self.calls += 1
            if self.calls == 1:                 # the timed-out wait
                raise subprocess.TimeoutExpired("x", timeout)
            return b"", b""                     # the reap after kill()

        def poll(self):
            return None

        def kill(self):
            self.returncode = -9

        def wait(self):
            return self.returncode

    monkeypatch.setattr(latex.subprocess, "Popen", Proc)
    pdf, log = latex.render_tex_to_pdf("loop")
    assert pdf is None
    assert "timed out" in log.lower()


def test_build_dir_is_reused_across_compiles(monkeypatch, isolated_build_dir):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/pdflatex")
    dirs = []
    monkeypatch.setattr(latex.subprocess, "Popen",
                        fake_popen(lambda cwd: dirs.append(cwd) or
                                   _write(cwd, "doc.pdf", b"%PDF")))
    latex.render_tex_to_pdf("one")
    latex.render_tex_to_pdf("two")
    assert dirs[0] == dirs[1] == str(isolated_build_dir)
    # …and the directory holds the latest source, not the first one.
    assert (isolated_build_dir / "doc.tex").read_text(encoding="utf-8") == "two"


def test_failed_compile_does_not_return_the_previous_pdf(monkeypatch):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/pdflatex")
    monkeypatch.setattr(latex.subprocess, "Popen",
                        fake_popen(lambda cwd: _write(cwd, "doc.pdf", b"%PDF good")))
    assert latex.render_tex_to_pdf("good")[0] == b"%PDF good"

    # The build dir persists, so a run that writes no PDF must report failure
    # rather than hand back the one still lying there.
    monkeypatch.setattr(latex.subprocess, "Popen",
                        fake_popen(lambda cwd: None, returncode=1, stdout=b"! boom"))
    pdf, log = latex.render_tex_to_pdf("broken")
    assert pdf is None
    assert "boom" in log


def test_complete_aux_is_restored_for_the_next_run(monkeypatch, isolated_build_dir):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/pdflatex")

    def succeed(cwd):
        _write(cwd, "doc.aux", b"\\newlabel{a}{{1}{1}}")
        _write(cwd, "doc.pdf", b"%PDF")

    monkeypatch.setattr(latex.subprocess, "Popen", fake_popen(succeed))
    latex.render_tex_to_pdf("one")
    assert (isolated_build_dir / "doc.aux.ok").exists()

    # A killed run leaves a partial .aux behind; the next compile must start
    # from the last complete one instead.
    (isolated_build_dir / "doc.aux").write_bytes(b"\\newlab")
    seen = {}
    monkeypatch.setattr(latex.subprocess, "Popen",
                        fake_popen(lambda cwd: seen.update(
                            aux=(isolated_build_dir / "doc.aux").read_bytes())))
    latex.render_tex_to_pdf("two")
    assert seen["aux"] == b"\\newlabel{a}{{1}{1}}"


def test_newer_compile_supersedes_the_running_one(monkeypatch):
    monkeypatch.setattr(latex, "find_tex", lambda: "/usr/bin/pdflatex")
    runs = {"n": 0}

    def behaviour(cwd):
        runs["n"] += 1
        if runs["n"] == 1:
            # A second compile arrives while this one is still running: it
            # kills this process and takes over as the current run.
            latex.render_tex_to_pdf("newer")
        else:
            _write(cwd, "doc.pdf", b"%PDF newer")

    monkeypatch.setattr(latex.subprocess, "Popen", fake_popen(behaviour))
    pdf, log = latex.render_tex_to_pdf("older")
    assert pdf is None
    assert log == latex.SUPERSEDED


def _write(cwd, name, data):
    with open(f"{cwd}/{name}", "wb") as fh:
        fh.write(data)
