"""Tests for app.converter — pure-Python ODT <-> HTML conversion.

The `pure_converter` fixture forces the dependency-free path, so these run
identically whether or not LibreOffice is installed.
"""

from __future__ import annotations

import shutil

from app import converter


# -- find_soffice -----------------------------------------------------------
def test_find_soffice_uses_which(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/soffice")
    assert converter.find_soffice() == "/usr/bin/soffice"


def test_find_soffice_none_when_absent(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    monkeypatch.setattr(converter.os.path, "isfile", lambda p: False)
    assert converter.find_soffice() is None


# -- small pure helpers -----------------------------------------------------
def test_wrap_formats_nests_all():
    out = converter._wrap_formats("x", {converter._BOLD, converter._ITALIC, converter._UNDERLINE})
    assert "<strong>" in out and "<em>" in out and "<u>" in out


def test_extract_body():
    full = "<html><head><title>t</title></head><body><p>hi</p></body></html>"
    assert converter._extract_body(full) == "<p>hi</p>"


def test_extract_body_without_body_tag_returns_input():
    assert converter._extract_body("<p>bare</p>") == "<p>bare</p>"


# -- HTML -> ODT ------------------------------------------------------------
def test_html_to_odt_produces_zip(pure_converter):
    data = converter.html_to_odt_bytes("<h1>Title</h1><p>Body</p>")
    assert isinstance(data, bytes) and len(data) > 0
    assert data[:2] == b"PK"  # ODT is a zip container


# -- round trip -------------------------------------------------------------
def test_roundtrip_headings_and_formats(pure_converter):
    html = "<h1>Title</h1><p><strong>bold</strong> and <em>italic</em> and <u>under</u></p>"
    odt = converter.html_to_odt_bytes(html)
    back = converter.odt_bytes_to_html(odt)

    assert "<h1>Title</h1>" in back
    assert "bold" in back and "italic" in back and "under" in back
    assert "<strong>" in back and "<em>" in back and "<u>" in back


def test_roundtrip_lists(pure_converter):
    odt = converter.html_to_odt_bytes("<ul><li>one</li><li>two</li></ul>")
    back = converter.odt_bytes_to_html(odt)
    assert "<ul>" in back and back.count("<li>") == 2
    assert "one" in back and "two" in back


def test_roundtrip_table(pure_converter):
    odt = converter.html_to_odt_bytes("<table><tr><td>A</td><td>B</td></tr></table>")
    back = converter.odt_bytes_to_html(odt)
    assert "<table>" in back and "A" in back and "B" in back


def test_roundtrip_font_family_size_color(pure_converter):
    # The editor emits font choices as inline CSS on spans / <font> tags. The
    # localised name (標楷體) is preserved on reopen because it comes from the
    # Asian font slot, which is what LibreOffice shows for CJK text.
    html = (
        '<p><span style="font-family: 標楷體, DFKai-SB, cursive;">楷</span>'
        '<font style="font-size: 18pt;">big</font>'
        '<span style="color: rgb(204, 0, 0);">red</span>'
        '<span style="background-color: rgb(255, 255, 0);">hl</span></p>'
    )
    odt = converter.html_to_odt_bytes(html)
    back = converter.odt_bytes_to_html(odt)
    assert "標楷體" in back
    assert "18pt" in back
    assert "#cc0000" in back
    assert "#ffff00" in back


def test_font_slots_western_and_asian(pure_converter):
    # LibreOffice renders CJK from the -asian slot (localised name the user
    # picked) and Latin from the Western slot (the Western alias).
    import zipfile
    import io

    html = '<p><span style="font-family: 新細明體, PMingLiU, serif;">測試</span></p>'
    odt = converter.html_to_odt_bytes(html)
    content = zipfile.ZipFile(io.BytesIO(odt)).read("content.xml").decode("utf-8")
    assert 'style:font-name-asian="新細明體"' in content
    assert 'style:font-name="PMingLiU"' in content


def test_import_paragraph_style_font(pure_converter):
    # A real ODT often sets the font on the paragraph style, not on runs. Import
    # must still carry that font onto the text so the editor reflects it.
    from odf.opendocument import OpenDocumentText
    from odf.style import Style, TextProperties
    from odf.text import P

    doc = OpenDocumentText()
    pstyle = Style(name="P1", family="paragraph")
    pstyle.addElement(TextProperties(fontnameasian="新細明體", fontname="PMingLiU"))
    doc.automaticstyles.addElement(pstyle)
    doc.text.addElement(P(stylename=pstyle, text="內文"))

    import tempfile
    import os

    buf = tempfile.NamedTemporaryFile(suffix=".odt", delete=False)
    buf.close()
    doc.save(buf.name)
    data = open(buf.name, "rb").read()
    os.unlink(buf.name)

    html = converter.odt_bytes_to_html(data)
    assert "font-family: 新細明體" in html


def test_primary_font_prefers_western_name():
    assert converter._primary_font(["新細明體", "PMingLiU", "serif"]) == "PMingLiU"
    assert converter._primary_font(["Arial", "sans-serif"]) == "Arial"
    assert converter._primary_font(["標楷體"]) == "標楷體"  # no Western alias to prefer


def test_css_bold_italic_underline_export(pure_converter):
    # styleWithCSS renders bold/italic/underline as inline styles, not <b>/<i>.
    html = (
        '<p><span style="font-weight: bold;">b</span>'
        '<span style="font-style: italic;">i</span>'
        '<span style="text-decoration: underline;">u</span></p>'
    )
    back = converter.odt_bytes_to_html(converter.html_to_odt_bytes(html))
    assert "<strong>b</strong>" in back
    assert "<em>i</em>" in back
    assert "<u>u</u>" in back


def test_html_escaping_roundtrip(pure_converter):
    odt = converter.html_to_odt_bytes("<p>a &lt; b &amp; c</p>")
    back = converter.odt_bytes_to_html(odt)
    assert "a < b & c" not in back  # angle brackets must stay escaped
    assert "&lt;" in back and "&amp;" in back


# -- paragraph alignment round trip ----------------------------------------

def test_roundtrip_alignment_all_values(pure_converter):
    # Inline text-align on blocks (what execCommand writes with styleWithCSS)
    # must survive an ODT round trip as fo:text-align.
    html = (
        '<p style="text-align: left;">L</p>'
        '<p style="text-align: center;">C</p>'
        '<p style="text-align: right;">R</p>'
        '<p style="text-align: justify;">J</p>'
    )
    odt = converter.html_to_odt_bytes(html)
    back = converter.odt_bytes_to_html(odt)
    assert 'style="text-align: left">L<' in back
    assert 'style="text-align: center">C<' in back
    assert 'style="text-align: right">R<' in back
    assert 'style="text-align: justify">J<' in back


def test_export_alignment_writes_fo_text_align(pure_converter):
    import io
    import zipfile

    odt = converter.html_to_odt_bytes('<p style="text-align: center;">mid</p>')
    content = zipfile.ZipFile(io.BytesIO(odt)).read("content.xml").decode("utf-8")
    assert 'fo:text-align="center"' in content
    assert 'fo:text-align="right"' not in content


def test_roundtrip_heading_alignment(pure_converter):
    odt = converter.html_to_odt_bytes('<h2 style="text-align: right;">R</h2>')
    back = converter.odt_bytes_to_html(odt)
    assert '<h2 style="text-align: right">R</h2>' in back


def test_import_alignment_from_paragraph_style(pure_converter):
    # A real ODT usually stores alignment on the paragraph style; import must
    # carry it onto the block as inline CSS.
    from odf.opendocument import OpenDocumentText
    from odf.style import ParagraphProperties, Style
    from odf.text import P

    doc = OpenDocumentText()
    pstyle = Style(name="P1", family="paragraph")
    pstyle.addElement(ParagraphProperties(textalign="center"))
    doc.automaticstyles.addElement(pstyle)
    doc.text.addElement(P(stylename=pstyle, text="置中"))

    import tempfile
    import os

    buf = tempfile.NamedTemporaryFile(suffix=".odt", delete=False)
    buf.close()
    doc.save(buf.name)
    data = open(buf.name, "rb").read()
    os.unlink(buf.name)

    html = converter.odt_bytes_to_html(data)
    assert "text-align: center" in html


def test_import_alignment_inherited_from_parent_style(pure_converter):
    from odf.opendocument import OpenDocumentText
    from odf.style import ParagraphProperties, Style
    from odf.text import P

    doc = OpenDocumentText()
    # Named (office:styles) styles are kept by odfpy on save — an automatic
    # style referenced only by another style's parent chain is pruned — which
    # is also how real LibreOffice files carry their style hierarchy.
    parent = Style(name="Base", family="paragraph")
    parent.addElement(ParagraphProperties(textalign="justify"))
    doc.styles.addElement(parent)
    child = Style(name="Child", family="paragraph", parentstylename="Base")
    doc.styles.addElement(child)
    doc.text.addElement(P(stylename=child, text="繼承"))

    import tempfile
    import os

    buf = tempfile.NamedTemporaryFile(suffix=".odt", delete=False)
    buf.close()
    doc.save(buf.name)
    data = open(buf.name, "rb").read()
    os.unlink(buf.name)

    html = converter.odt_bytes_to_html(data)
    assert "text-align: justify" in html


def test_no_alignment_adds_no_style_attr(pure_converter):
    # Blocks without alignment keep their clean output (no stray style attr).
    html = "<p>plain</p><h3>plain heading</h3>"
    back = converter.odt_bytes_to_html(converter.html_to_odt_bytes(html))
    assert "<p>plain</p>" in back
    assert "<h3>plain heading</h3>" in back
    assert "text-align" not in back


# -- page breaks ------------------------------------------------------------

def test_roundtrip_page_break(pure_converter):
    import io
    import zipfile

    html = '<p>before</p><p style="page-break-after: always"><br></p><p>after</p>'
    odt = converter.html_to_odt_bytes(html)
    content = zipfile.ZipFile(io.BytesIO(odt)).read("content.xml").decode("utf-8")
    assert 'fo:break-after="page"' in content

    back = converter.odt_bytes_to_html(odt)
    assert 'class="page-break"' in back
    assert "before" in back and "after" in back
    # The marker must sit between the two paragraphs, not before the first.
    assert back.index("before") < back.index("page-break") < back.index("after")


def test_import_page_break_before(pure_converter):
    from odf.opendocument import OpenDocumentText
    from odf.style import ParagraphProperties, Style
    from odf.text import P
    import tempfile
    import os

    doc = OpenDocumentText()
    pstyle = Style(name="P1", family="paragraph")
    pstyle.addElement(ParagraphProperties(breakbefore="page"))
    doc.automaticstyles.addElement(pstyle)
    doc.text.addElement(P(stylename=pstyle, text="new page"))

    buf = tempfile.NamedTemporaryFile(suffix=".odt", delete=False)
    buf.close()
    doc.save(buf.name)
    data = open(buf.name, "rb").read()
    os.unlink(buf.name)

    html = converter.odt_bytes_to_html(data)
    assert 'class="page-break"' in html
    assert html.index("page-break") < html.index("new page")


# -- inline images ----------------------------------------------------------

_TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c626001000000ffff03000006000557bfabd40000000049"
    "454e44ae426082"
)


def test_roundtrip_inline_image(pure_converter):
    import base64
    import io
    import zipfile

    src = "data:image/png;base64," + base64.b64encode(_TINY_PNG).decode("ascii")
    html = f'<p><img src="{src}" style="width: 600px; height: 400px;" alt=""></p>'

    odt = converter.html_to_odt_bytes(html)
    z = zipfile.ZipFile(io.BytesIO(odt))
    names = z.namelist()
    assert any(name.startswith("Pictures/") for name in names)
    content = z.read("content.xml").decode("utf-8")
    assert "draw:image" in content and "xlink:href" in content

    back = converter.odt_bytes_to_html(odt)
    assert '<img src="data:image/png;base64,' in back
    assert "width: 15.875cm;" in back   # 600px -> cm (96px = 2.54cm)
    assert "height: 10.5833cm;" in back  # 400px -> cm


def test_non_data_image_is_ignored(pure_converter):
    import io
    import zipfile

    html = '<p><img src="http://example.com/x.png" alt=""></p>'
    odt = converter.html_to_odt_bytes(html)
    names = zipfile.ZipFile(io.BytesIO(odt)).namelist()
    assert not any(name.startswith("Pictures/") for name in names)


def test_length_to_odf_normalises_units():
    assert converter._length_to_odf("600px") == "15.875cm"
    assert converter._length_to_odf("2cm") == "2cm"
    assert converter._length_to_odf("72pt") == "72pt"
    assert converter._length_to_odf("") is None
