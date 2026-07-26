"""Integration tests for app.latex that use a real LaTeX engine.

Everything in test_latex.py stubs the subprocess, so it can check the wrapper's
branching but not whether the engine accepts the arguments we pass or whether
reusing the build directory really does what it is there for. These do — and are
skipped on a machine without an engine installed. To run them:

    docker build --target test-tex -t ai-words-test-tex .
    docker run --rm ai-words-test-tex
"""

from __future__ import annotations

import pytest

from app import latex

pytestmark = pytest.mark.skipif(
    latex.find_tex() is None,
    reason="no LaTeX engine installed (run the test-tex Docker target)",
)

MINIMAL = r"""\documentclass{article}
\begin{document}
Hello.
\end{document}
"""

# \ref needs the .aux written by a previous run to resolve; on a first-ever
# compile LaTeX warns about undefined references instead.
CROSS_REF = r"""\documentclass{article}
\begin{document}
\section{Intro}\label{sec:intro}
See section \ref{sec:intro}.
\end{document}
"""

CJK = r"""\documentclass{article}
\usepackage{xeCJK}
\setCJKmainfont{Noto Sans CJK TC}
\begin{document}
你好，世界。繁體中文測試。
\end{document}
"""


@pytest.fixture(autouse=True)
def isolated_build_dir(tmp_path, monkeypatch):
    """Give each test its own build directory, as a fresh server would have."""
    monkeypatch.setattr(latex, "_work_dir", str(tmp_path))
    monkeypatch.setattr(latex, "_running", None)
    return tmp_path


def test_minimal_document_compiles():
    # Also covers the engine accepting every flag in _engine_argv: a rejected
    # one would abort the run before a PDF was produced.
    pdf, log = latex.render_tex_to_pdf(MINIMAL)
    assert pdf is not None, log
    assert pdf.startswith(b"%PDF")


def test_broken_document_returns_the_compiler_log():
    pdf, log = latex.render_tex_to_pdf(r"\documentclass{article}\begin{document}\nosuchmacro")
    assert pdf is None
    assert "undefined control sequence" in log.lower()


def test_failure_after_success_does_not_return_the_stale_pdf():
    assert latex.render_tex_to_pdf(MINIMAL)[0] is not None
    # The build directory still holds the PDF from the run above; a failing
    # compile must report the failure rather than hand that one back.
    pdf, _ = latex.render_tex_to_pdf(r"\documentclass{article}\begin{document}\nosuchmacro")
    assert pdf is None


def test_cross_reference_resolves_on_the_next_compile(isolated_build_dir):
    first = latex.render_tex_to_pdf(CROSS_REF)[1]
    second = latex.render_tex_to_pdf(CROSS_REF)[1]
    # First run has no .aux to read; the second reuses the one it left behind.
    assert "undefined references" in first.lower()
    assert "undefined references" not in second.lower()
    assert (isolated_build_dir / "doc.aux.ok").exists()


def test_partial_aux_from_a_killed_run_is_discarded(isolated_build_dir):
    latex.render_tex_to_pdf(CROSS_REF)          # leaves a complete .aux + snapshot
    # Simulate what killing a compile mid-write leaves behind.
    (isolated_build_dir / "doc.aux").write_text("\\relax \n\\newlabel{sec:in", encoding="utf-8")
    pdf, log = latex.render_tex_to_pdf(CROSS_REF)
    assert pdf is not None, log
    assert "undefined references" not in log.lower()


def test_cjk_document_compiles():
    # The image ships texlive-lang-chinese + fonts-noto-cjk for this.
    pdf, log = latex.render_tex_to_pdf(CJK)
    assert pdf is not None, log
    assert pdf.startswith(b"%PDF")
