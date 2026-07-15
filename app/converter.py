"""Convert between ODT and HTML.

Primary path is a pure-Python converter built on `odfpy`, so the app works with
no external dependencies. If a LibreOffice `soffice` binary is available it is
used instead for higher-fidelity conversion (auto-detected; never required).

The pure-Python converter handles the common word-processing subset:
headings, paragraphs, bold/italic/underline runs, ordered/unordered lists,
line breaks and simple tables. It is intentionally lossy for exotic features —
the goal is a clean, editable HTML representation, not perfect fidelity.
"""

from __future__ import annotations

import html as html_module
import os
import shutil
import subprocess
import tempfile
from html.parser import HTMLParser

from odf import table
from odf.element import Element, Text
from odf.opendocument import OpenDocumentText, load
from odf.style import Style, TextProperties
from odf.text import H, LineBreak, ListItem, P, Span
from odf.text import List as OdfList

# ---------------------------------------------------------------------------
# LibreOffice detection (optional, higher fidelity)
# ---------------------------------------------------------------------------

_SOFFICE_CANDIDATES = [
    "soffice",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/usr/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
]


def find_soffice() -> str | None:
    """Return a usable soffice executable path, or None if not installed."""
    which = shutil.which("soffice")
    if which:
        return which
    for candidate in _SOFFICE_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return None


def _libreoffice_convert(src: str, out_dir: str, out_filter: str) -> str | None:
    soffice = find_soffice()
    if not soffice:
        return None
    try:
        subprocess.run(
            [soffice, "--headless", "--convert-to", out_filter, "--outdir", out_dir, src],
            check=True,
            capture_output=True,
            timeout=60,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    base = os.path.splitext(os.path.basename(src))[0]
    ext = out_filter.split(":")[0]
    produced = os.path.join(out_dir, f"{base}.{ext}")
    return produced if os.path.isfile(produced) else None


# ---------------------------------------------------------------------------
# ODT -> HTML (pure python)
# ---------------------------------------------------------------------------

_BOLD = "bold"
_ITALIC = "italic"
_UNDERLINE = "underline"


def _collect_text_styles(doc) -> dict[str, set[str]]:
    """Map a style name -> the set of run formats it implies."""
    styles: dict[str, set[str]] = {}
    for container in (doc.automaticstyles, doc.styles):
        for style in container.getElementsByType(Style):
            name = style.getAttribute("name")
            if not name:
                continue
            fmts: set[str] = set()
            for props in style.getElementsByType(TextProperties):
                weight = props.getAttribute("fontweight")
                if weight and weight != "normal":
                    fmts.add(_BOLD)
                fstyle = props.getAttribute("fontstyle")
                if fstyle in ("italic", "oblique"):
                    fmts.add(_ITALIC)
                underline = props.getAttribute("textunderlinestyle")
                if underline and underline != "none":
                    fmts.add(_UNDERLINE)
            styles[name] = fmts
    return styles


def _wrap_formats(inner: str, fmts: set[str]) -> str:
    if _BOLD in fmts:
        inner = f"<strong>{inner}</strong>"
    if _ITALIC in fmts:
        inner = f"<em>{inner}</em>"
    if _UNDERLINE in fmts:
        inner = f"<u>{inner}</u>"
    return inner


def _inline_to_html(node: Element, styles: dict[str, set[str]]) -> str:
    """Render the inline content of a paragraph/heading node to HTML."""
    parts: list[str] = []
    for child in node.childNodes:
        if isinstance(child, Text):
            parts.append(html_module.escape(child.data))
        elif isinstance(child, Element):
            qname = child.qname[1]
            if qname == "span":
                style_name = child.getAttribute("stylename")
                fmts = styles.get(style_name, set()) if style_name else set()
                parts.append(_wrap_formats(_inline_to_html(child, styles), fmts))
            elif qname == "line-break":
                parts.append("<br>")
            elif qname == "tab":
                parts.append("&emsp;")
            elif qname in ("s",):  # spaces
                count = child.getAttribute("c")
                parts.append("&nbsp;" * (int(count) if count else 1))
            elif qname == "a":  # hyperlink
                href = child.getAttribute("href") or "#"
                parts.append(
                    f'<a href="{html_module.escape(href, quote=True)}">'
                    f"{_inline_to_html(child, styles)}</a>"
                )
            else:
                parts.append(_inline_to_html(child, styles))
    return "".join(parts)


def _list_to_html(node: Element, styles: dict[str, set[str]], ordered: bool) -> str:
    tag = "ol" if ordered else "ul"
    items: list[str] = []
    for child in node.childNodes:
        if isinstance(child, Element) and child.qname[1] == "list-item":
            inner: list[str] = []
            for sub in child.childNodes:
                if isinstance(sub, Element):
                    inner.append(_block_to_html(sub, styles, inside_li=True))
            items.append(f"<li>{''.join(inner)}</li>")
    return f"<{tag}>{''.join(items)}</{tag}>"


def _table_to_html(node: Element, styles: dict[str, set[str]]) -> str:
    rows: list[str] = []
    for row in node.getElementsByType(table.TableRow):
        cells: list[str] = []
        for cell in row.getElementsByType(table.TableCell):
            inner: list[str] = []
            for sub in cell.childNodes:
                if isinstance(sub, Element):
                    inner.append(_block_to_html(sub, styles))
            cells.append(f"<td>{''.join(inner)}</td>")
        rows.append(f"<tr>{''.join(cells)}</tr>")
    return f"<table>{''.join(rows)}</table>"


def _block_to_html(node: Element, styles: dict[str, set[str]], inside_li: bool = False) -> str:
    qname = node.qname[1]
    if qname == "h":
        level = node.getAttribute("outlinelevel") or "1"
        try:
            level = max(1, min(6, int(level)))
        except (TypeError, ValueError):
            level = 1
        return f"<h{level}>{_inline_to_html(node, styles)}</h{level}>"
    if qname == "p":
        inner = _inline_to_html(node, styles)
        if inside_li:
            return inner  # avoid <p> inside <li> for cleaner editing
        return f"<p>{inner}</p>" if inner else "<p><br></p>"
    if qname == "list":
        # Heuristic: treat as ordered if the style name hints at numbering.
        style_name = (node.getAttribute("stylename") or "").lower()
        ordered = "numbering" in style_name or "ordered" in style_name or "num" in style_name
        return _list_to_html(node, styles, ordered)
    if qname == "table":
        return _table_to_html(node, styles)
    if isinstance(node, Element):
        # Unknown block: recurse into children.
        return "".join(
            _block_to_html(c, styles) for c in node.childNodes if isinstance(c, Element)
        )
    return ""


def odt_bytes_to_html(data: bytes) -> str:
    """Convert raw ODT bytes to an HTML fragment (body content only)."""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "input.odt")
        with open(src, "wb") as fh:
            fh.write(data)

        # High-fidelity path first.
        produced = _libreoffice_convert(src, tmp, "html")
        if produced:
            with open(produced, "r", encoding="utf-8", errors="replace") as fh:
                full = fh.read()
            return _extract_body(full)

        # Pure-python fallback.
        doc = load(src)
        styles = _collect_text_styles(doc)
        blocks: list[str] = []
        for node in doc.text.childNodes:
            if isinstance(node, Element):
                rendered = _block_to_html(node, styles)
                if rendered:
                    blocks.append(rendered)
        return "\n".join(blocks) if blocks else "<p><br></p>"


def _extract_body(full_html: str) -> str:
    lower = full_html.lower()
    start = lower.find("<body")
    if start == -1:
        return full_html
    start = full_html.find(">", start) + 1
    end = lower.rfind("</body>")
    return full_html[start:end] if end != -1 else full_html[start:]


# ---------------------------------------------------------------------------
# HTML -> ODT (pure python)
# ---------------------------------------------------------------------------

_BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "tr", "td", "div"}
_INLINE_FORMAT_TAGS = {
    "strong": _BOLD,
    "b": _BOLD,
    "em": _ITALIC,
    "i": _ITALIC,
    "u": _UNDERLINE,
}


class _HtmlToOdt(HTMLParser):
    """Streaming HTML parser that builds an ODF text document."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.doc = OpenDocumentText()
        self._style_cache: dict[frozenset, Style] = {}
        self._style_counter = 0
        self._fmt_stack: list[str] = []
        self._block: Element | None = None
        self._block_kind: str | None = None
        self._list_stack: list[Element] = []
        self._li: Element | None = None
        self._pending_row: Element | None = None
        self._pending_cell: Element | None = None
        self._table: Element | None = None

    # -- style helpers ----------------------------------------------------
    def _style_for(self, fmts: frozenset) -> Style | None:
        if not fmts:
            return None
        if fmts in self._style_cache:
            return self._style_cache[fmts]
        self._style_counter += 1
        style = Style(name=f"T{self._style_counter}", family="text")
        props = {}
        if _BOLD in fmts:
            props["fontweight"] = "bold"
        if _ITALIC in fmts:
            props["fontstyle"] = "italic"
        if _UNDERLINE in fmts:
            props["textunderlinestyle"] = "solid"
            props["textunderlinewidth"] = "auto"
            props["textunderlinecolor"] = "font-color"
        style.addElement(TextProperties(**props))
        self.doc.automaticstyles.addElement(style)
        self._style_cache[fmts] = style
        return style

    # -- block helpers ----------------------------------------------------
    def _new_block(self, kind: str) -> None:
        self._finish_block()
        if kind.startswith("h") and len(kind) == 2 and kind[1].isdigit():
            self._block = H(outlinelevel=int(kind[1]))
        else:
            self._block = P()
        self._block_kind = kind

    def _finish_block(self) -> None:
        if self._block is None:
            return
        target = self._container_for_block()
        target.addElement(self._block)
        self._block = None
        self._block_kind = None

    def _container_for_block(self) -> Element:
        if self._pending_cell is not None:
            return self._pending_cell
        if self._li is not None:
            return self._li
        return self.doc.text

    # -- parser callbacks -------------------------------------------------
    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag == "br":
            if self._block is None:
                self._new_block("p")
            self._block.addElement(LineBreak())
            return
        if tag in _INLINE_FORMAT_TAGS:
            self._fmt_stack.append(_INLINE_FORMAT_TAGS[tag])
            return
        if tag in ("ul", "ol"):
            self._finish_block()
            lst = OdfList()
            self._container_for_block().addElement(lst)
            self._list_stack.append(lst)
            return
        if tag == "li":
            self._li = ListItem()
            if self._list_stack:
                self._list_stack[-1].addElement(self._li)
            self._new_block("p")
            return
        if tag == "table":
            self._finish_block()
            self._table = table.Table()
            self.doc.text.addElement(self._table)
            return
        if tag == "tr" and self._table is not None:
            self._pending_row = table.TableRow()
            self._table.addElement(self._pending_row)
            return
        if tag in ("td", "th") and self._pending_row is not None:
            self._pending_cell = table.TableCell()
            self._pending_row.addElement(self._pending_cell)
            self._new_block("p")
            return
        if tag in ("p", "div", "h1", "h2", "h3", "h4", "h5", "h6"):
            self._new_block(tag)
            return

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _INLINE_FORMAT_TAGS:
            fmt = _INLINE_FORMAT_TAGS[tag]
            # Pop the most recent matching format.
            for i in range(len(self._fmt_stack) - 1, -1, -1):
                if self._fmt_stack[i] == fmt:
                    del self._fmt_stack[i]
                    break
            return
        if tag in ("p", "div", "h1", "h2", "h3", "h4", "h5", "h6"):
            self._finish_block()
            return
        if tag == "li":
            self._finish_block()
            self._li = None
            return
        if tag in ("ul", "ol"):
            if self._list_stack:
                self._list_stack.pop()
            return
        if tag in ("td", "th"):
            self._finish_block()
            self._pending_cell = None
            return
        if tag == "tr":
            self._pending_row = None
            return
        if tag == "table":
            self._table = None
            return

    def handle_data(self, data: str) -> None:
        if not data:
            return
        if self._block is None:
            if not data.strip():
                return
            self._new_block("p")
        fmts = frozenset(self._fmt_stack)
        style = self._style_for(fmts)
        if style is not None:
            span = Span(stylename=style)
            span.addText(data)
            self._block.addElement(span)
        else:
            self._block.addText(data)

    def close(self):  # type: ignore[override]
        super().close()
        self._finish_block()
        return self.doc


def html_to_odt_bytes(html: str) -> bytes:
    """Convert an HTML fragment to raw ODT bytes."""
    soffice = find_soffice()
    if soffice:
        produced = _html_to_odt_via_libreoffice(html, soffice)
        if produced is not None:
            return produced

    parser = _HtmlToOdt()
    parser.feed(html)
    doc = parser.close()
    buf = tempfile.NamedTemporaryFile(suffix=".odt", delete=False)
    buf.close()
    try:
        doc.save(buf.name)
        with open(buf.name, "rb") as fh:
            return fh.read()
    finally:
        os.unlink(buf.name)


def _html_to_odt_via_libreoffice(html: str, soffice: str) -> bytes | None:
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "input.html")
        full = (
            "<!DOCTYPE html><html><head><meta charset='utf-8'></head>"
            f"<body>{html}</body></html>"
        )
        with open(src, "w", encoding="utf-8") as fh:
            fh.write(full)
        produced = _libreoffice_convert(src, tmp, "odt")
        if not produced:
            return None
        with open(produced, "rb") as fh:
            return fh.read()
