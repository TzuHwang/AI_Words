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
import re
import shutil
import subprocess
import tempfile
from html.parser import HTMLParser

from odf import table
from odf.element import Element, Text
from odf.opendocument import OpenDocumentText, load
from odf.style import DefaultStyle, FontFace, Style, TextProperties
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


def _read_text_props(style) -> tuple[set[str], dict[str, str]]:
    """Extract run formats + css declarations from a style's TextProperties."""
    fmts: set[str] = set()
    css: dict[str, str] = {}
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
        # Prefer the Asian slot so a reopened CJK document shows the localised
        # name the user originally picked.
        family = (
            props.getAttribute("fontfamilyasian")
            or props.getAttribute("fontnameasian")
            or props.getAttribute("fontfamily")
            or props.getAttribute("fontname")
        )
        if family:
            css["font-family"] = family
        size = props.getAttribute("fontsize")
        if size:
            css["font-size"] = size
        color = props.getAttribute("color")
        if color and color != "transparent":
            css["color"] = color
        background = props.getAttribute("backgroundcolor")
        if background and background != "transparent":
            css["background-color"] = background
    return fmts, css


def _collect_styles(doc) -> tuple[dict[str, dict], str | None]:
    """Return ``(styles, default_font)``.

    ``styles`` maps a style name -> ``{"flags", "css", "parent"}``. ``default_font``
    is the font-family from the default paragraph style, used as the fallback for
    paragraphs whose font is inherited rather than set on a run.
    """
    styles: dict[str, dict] = {}
    for container in (doc.automaticstyles, doc.styles):
        for style in container.getElementsByType(Style):
            name = style.getAttribute("name")
            if not name:
                continue
            fmts, css = _read_text_props(style)
            styles[name] = {
                "flags": fmts,
                "css": css,
                "parent": style.getAttribute("parentstylename"),
            }
    default_font = None
    for ds in doc.styles.getElementsByType(DefaultStyle):
        if ds.getAttribute("family") == "paragraph":
            _, css = _read_text_props(ds)
            default_font = css.get("font-family")
            break
    return styles, default_font


def _paragraph_font(style_name: str | None, styles: dict[str, dict],
                    default_font: str | None) -> str | None:
    """Resolve a paragraph's font from its style chain, else the default font."""
    seen: set[str] = set()
    name = style_name
    while name and name not in seen:
        seen.add(name)
        entry = styles.get(name)
        if not entry:
            break
        font = entry["css"].get("font-family")
        if font:
            return font
        name = entry["parent"]
    return default_font


def _wrap_formats(inner: str, fmts: set[str]) -> str:
    if _BOLD in fmts:
        inner = f"<strong>{inner}</strong>"
    if _ITALIC in fmts:
        inner = f"<em>{inner}</em>"
    if _UNDERLINE in fmts:
        inner = f"<u>{inner}</u>"
    return inner


def _wrap_run(inner: str, info: dict) -> str:
    """Wrap a run's HTML with its formatting tags and, if any, a styled span."""
    css = info.get("css") if info else None
    if css:
        decl = ";".join(f"{k}: {v}" for k, v in css.items())
        inner = f'<span style="{html_module.escape(decl, quote=True)}">{inner}</span>'
    return _wrap_formats(inner, info.get("flags", set()) if info else set())


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
                info = styles.get(style_name, {}) if style_name else {}
                parts.append(_wrap_run(_inline_to_html(child, styles), info))
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


def _apply_paragraph_font(inner: str, node: Element, styles: dict[str, dict],
                          default_font: str | None) -> str:
    """Wrap a block's inline HTML in a font span when the font is inherited from
    the paragraph/default style rather than set on a run — so it isn't lost."""
    if not inner:
        return inner
    font = _paragraph_font(node.getAttribute("stylename"), styles, default_font)
    if not font:
        return inner
    decl = html_module.escape(f"font-family: {font}", quote=True)
    return f'<span style="{decl}">{inner}</span>'


def _list_to_html(node: Element, styles: dict[str, dict], ordered: bool,
                  default_font: str | None = None) -> str:
    tag = "ol" if ordered else "ul"
    items: list[str] = []
    for child in node.childNodes:
        if isinstance(child, Element) and child.qname[1] == "list-item":
            inner: list[str] = []
            for sub in child.childNodes:
                if isinstance(sub, Element):
                    inner.append(_block_to_html(sub, styles, default_font, inside_li=True))
            items.append(f"<li>{''.join(inner)}</li>")
    return f"<{tag}>{''.join(items)}</{tag}>"


def _table_to_html(node: Element, styles: dict[str, dict],
                   default_font: str | None = None) -> str:
    rows: list[str] = []
    for row in node.getElementsByType(table.TableRow):
        cells: list[str] = []
        for cell in row.getElementsByType(table.TableCell):
            inner: list[str] = []
            for sub in cell.childNodes:
                if isinstance(sub, Element):
                    inner.append(_block_to_html(sub, styles, default_font))
            cells.append(f"<td>{''.join(inner)}</td>")
        rows.append(f"<tr>{''.join(cells)}</tr>")
    return f"<table>{''.join(rows)}</table>"


def _block_to_html(node: Element, styles: dict[str, dict],
                   default_font: str | None = None, inside_li: bool = False) -> str:
    qname = node.qname[1]
    if qname == "h":
        level = node.getAttribute("outlinelevel") or "1"
        try:
            level = max(1, min(6, int(level)))
        except (TypeError, ValueError):
            level = 1
        inner = _apply_paragraph_font(_inline_to_html(node, styles), node, styles, default_font)
        return f"<h{level}>{inner}</h{level}>"
    if qname == "p":
        inner = _inline_to_html(node, styles)
        if inside_li:
            return inner  # avoid <p> inside <li> for cleaner editing
        inner = _apply_paragraph_font(inner, node, styles, default_font)
        return f"<p>{inner}</p>" if inner else "<p><br></p>"
    if qname == "list":
        # Heuristic: treat as ordered if the style name hints at numbering.
        style_name = (node.getAttribute("stylename") or "").lower()
        ordered = "numbering" in style_name or "ordered" in style_name or "num" in style_name
        return _list_to_html(node, styles, ordered, default_font)
    if qname == "table":
        return _table_to_html(node, styles, default_font)
    if isinstance(node, Element):
        # Unknown block: recurse into children.
        return "".join(
            _block_to_html(c, styles, default_font)
            for c in node.childNodes if isinstance(c, Element)
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
        styles, default_font = _collect_styles(doc)
        blocks: list[str] = []
        for node in doc.text.childNodes:
            if isinstance(node, Element):
                rendered = _block_to_html(node, styles, default_font)
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

# ODF TextProperties keyword args each run format maps to. Weight/style are set
# on the Western, Asian (CJK) and CTL slots alike so formatting on Chinese text
# — which LibreOffice reads from the -asian slot — isn't dropped.
_FMT_PROPS: dict[str, dict[str, str]] = {
    _BOLD: {"fontweight": "bold", "fontweightasian": "bold", "fontweightcomplex": "bold"},
    _ITALIC: {"fontstyle": "italic", "fontstyleasian": "italic", "fontstylecomplex": "italic"},
    _UNDERLINE: {  # underline is script-independent in ODF
        "textunderlinestyle": "solid",
        "textunderlinewidth": "auto",
        "textunderlinecolor": "font-color",
    },
}


def _parse_style(style: str) -> dict[str, str]:
    """Parse an inline ``style="a: b; c: d"`` attribute into a dict."""
    decls: dict[str, str] = {}
    for part in style.split(";"):
        if ":" in part:
            key, value = part.split(":", 1)
            decls[key.strip().lower()] = value.strip()
    return decls


def _norm_color(value: str | None) -> str | None:
    """Normalise a CSS colour to ``#rrggbb``; drop anything non-literal."""
    if not value:
        return None
    v = value.strip().lower()
    if v in ("transparent", "inherit", "initial", "currentcolor", "font-color", "windowtext"):
        return None
    m = re.fullmatch(r"rgba?\(([^)]+)\)", v)
    if m:
        parts = [p.strip() for p in m.group(1).split(",")]
        try:
            r, g, b = (max(0, min(255, round(float(parts[i])))) for i in range(3))
        except (ValueError, IndexError):
            return None
        return f"#{r:02x}{g:02x}{b:02x}"
    if re.fullmatch(r"#[0-9a-f]{6}", v):
        return v
    if re.fullmatch(r"#[0-9a-f]{3}", v):
        return "#" + "".join(c * 2 for c in v[1:])
    return None


def _norm_font_size(value: str | None) -> str | None:
    """Keep pt/em/% sizes as-is; convert px to pt (96px = 72pt)."""
    if not value:
        return None
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(pt|px|em|rem|%)", value.strip().lower())
    if not m:
        return None
    num, unit = float(m.group(1)), m.group(2)
    if unit == "px":
        pt = num * 72 / 96
        return f"{pt:g}pt"
    return f"{num:g}{unit}"


_GENERIC_FAMILIES = {
    "serif", "sans-serif", "monospace", "cursive", "fantasy",
    "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
    "math", "emoji", "fangsong",
}


def _primary_font(names: list[str]) -> str:
    """Choose the single font name to write into the ODT.

    ODF ``style:font-name`` names one font — LibreOffice/Word don't do CSS-style
    fallback across a list. Our font picker lists the localised CJK name first
    (e.g. "新細明體") for display, but LibreOffice registers the font under its
    Western name ("PMingLiU") and can't resolve the localised alias, so prefer
    the first ASCII (Western) name; fall back to the first concrete name.
    """
    concrete = [n for n in names if n.lower() not in _GENERIC_FAMILIES]
    if not concrete:
        return names[0]
    for name in concrete:
        if name.isascii():
            return name
    return concrete[0]


def _run_props(attrs) -> dict[str, str]:
    """Read font-family / size / colour formatting off a span/font tag."""
    attr = {k.lower(): (v or "") for k, v in attrs}
    decls = _parse_style(attr.get("style", ""))
    if attr.get("face"):
        decls.setdefault("font-family", attr["face"])
    if attr.get("color"):
        decls.setdefault("color", attr["color"])

    props: dict[str, str] = {}
    family = decls.get("font-family")
    if family:
        names = [n.strip().strip("\"'") for n in family.split(",") if n.strip()]
        if names:
            # LibreOffice renders Chinese with the -asian slot and Latin with the
            # Western slot, so set both. The Asian/CTL slots keep the name the
            # user picked (e.g. the localised "新細明體") so LibreOffice shows that
            # on CJK text; the Western slot uses the Western alias ("PMingLiU")
            # which resolves cleanly for Latin characters in the same run.
            display = names[0]
            western = _primary_font(names)
            props["fontfamily"] = western
            props["fontname"] = western
            for key in ("fontfamilyasian", "fontnameasian",
                        "fontfamilycomplex", "fontnamecomplex"):
                props[key] = display
    size = _norm_font_size(decls.get("font-size"))
    if size:
        props["fontsize"] = size
        props["fontsizeasian"] = size
        props["fontsizecomplex"] = size
    color = _norm_color(decls.get("color"))
    if color:
        props["color"] = color
    background = _norm_color(decls.get("background-color") or decls.get("background"))
    if background:
        props["backgroundcolor"] = background
    # execCommand with styleWithCSS emits bold/italic/underline as inline CSS too.
    if decls.get("font-weight") in ("bold", "bolder", "600", "700", "800", "900"):
        props["fontweight"] = "bold"
    if decls.get("font-style") in ("italic", "oblique"):
        props["fontstyle"] = "italic"
    if "underline" in decls.get("text-decoration", ""):
        props.update(_FMT_PROPS[_UNDERLINE])
    return props


class _HtmlToOdt(HTMLParser):
    """Streaming HTML parser that builds an ODF text document."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.doc = OpenDocumentText()
        self._style_cache: dict[frozenset, Style] = {}
        self._style_counter = 0
        self._fmt_stack: list[str] = []
        self._css_stack: list[dict[str, str]] = []  # span/font formatting
        self._fonts: set[str] = set()               # declared font faces
        self._block: Element | None = None
        self._block_kind: str | None = None
        self._list_stack: list[Element] = []
        self._li: Element | None = None
        self._pending_row: Element | None = None
        self._pending_cell: Element | None = None
        self._table: Element | None = None

    # -- style helpers ----------------------------------------------------
    def _current_props(self) -> dict[str, str]:
        """Merge the active b/i/u tags and span/font CSS into ODF properties."""
        props: dict[str, str] = {}
        for fmt in self._fmt_stack:
            props.update(_FMT_PROPS[fmt])
        for css in self._css_stack:
            props.update(css)
        return props

    def _ensure_font(self, family: str) -> None:
        if family in self._fonts:
            return
        self._fonts.add(family)
        self.doc.fontfacedecls.addElement(FontFace(name=family, fontfamily=family))

    def _style_for(self, props: dict[str, str]) -> Style | None:
        if not props:
            return None
        key = frozenset(props.items())
        if key in self._style_cache:
            return self._style_cache[key]
        self._style_counter += 1
        style = Style(name=f"T{self._style_counter}", family="text")
        style.addElement(TextProperties(**props))
        self.doc.automaticstyles.addElement(style)
        self._style_cache[key] = style
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
        if tag in ("span", "font"):
            props = _run_props(attrs)
            for key in ("fontname", "fontnameasian", "fontnamecomplex"):
                if props.get(key):
                    self._ensure_font(props[key])
            self._css_stack.append(props)
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
        if tag in ("span", "font"):
            if self._css_stack:
                self._css_stack.pop()
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
        style = self._style_for(self._current_props())
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
