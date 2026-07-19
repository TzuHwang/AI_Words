"""Tests for app.converter — pure-Python ODT <-> HTML conversion.

The `pure_converter` fixture forces the dependency-free path, so these run
identically whether or not LibreOffice is installed.
"""

from __future__ import annotations

import shutil

import pytest

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


def test_html_escaping_roundtrip(pure_converter):
    odt = converter.html_to_odt_bytes("<p>a &lt; b &amp; c</p>")
    back = converter.odt_bytes_to_html(odt)
    assert "a < b & c" not in back  # angle brackets must stay escaped
    assert "&lt;" in back and "&amp;" in back
