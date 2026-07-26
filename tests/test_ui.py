"""Browser tests for the AI pane, run against a real page in real Chromium.

These exist because the rest of the suite cannot see layout. The bug that
prompted them — the LaTeX editor's chat transcript never appearing, because
`.messages` is `display: none` until it has the `.active` class the ODT editor's
tab code adds — is invisible to any test that does not apply CSS. So is the
symptom it caused: the composer riding up under the pane header instead of
sitting at the bottom.

Both editors now build their pane from the same ai-pane.js, so nearly every test
here is parametrised over the two pages and asserts they agree. That is the
property worth defending: not that the pane looks a particular way, but that it
looks the same in both places.

Skipped unless pytest-playwright and a browser are installed. To run them:

    pip install pytest-playwright && playwright install chromium
    pytest tests/test_ui.py
"""

from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import pytest

# The plugin is what supplies the `page` fixture, so check for it rather than
# for playwright itself: without it these tests would error on a missing
# fixture instead of skipping.
pytest.importorskip("pytest_playwright", reason="pytest-playwright is not installed")

from playwright.sync_api import expect  # noqa: E402

# Both editors. Every layout assertion below runs against each, so a change that
# only lands on one of them fails here.
PAGES = ["/editor", "/latex"]


@pytest.fixture(scope="session", autouse=True)
def _require_browser():
    """Skip rather than error when the browser binary was never downloaded."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        try:
            installed = Path(p.chromium.executable_path).is_file()
        except Exception:
            installed = False
    if not installed:
        pytest.skip("no Chromium for Playwright (run: playwright install chromium)")


@pytest.fixture(scope="session")
def live_server(tmp_path_factory):
    """Serve the real app on a loopback port for the browser to talk to.

    Persistent state is redirected the same way conftest.py does it for the
    API tests — the server runs in this process, so patching the modules is
    enough — and Ollama discovery is stubbed so a local daemon can't change
    what the model dropdown contains.
    """
    import uvicorn

    from app import config, server, skills

    state = tmp_path_factory.mktemp("ui-server")
    mp = pytest.MonkeyPatch()
    mp.setattr(config, "CONFIG_PATH", state / "config.json")
    mp.setattr(config, "discover_ollama_models", lambda *a, **k: [])
    mp.setattr(skills, "SKILLS_DIR", state / "skills")

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    uv = uvicorn.Server(uvicorn.Config(server.app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=uv.run, daemon=True)
    thread.start()

    deadline = time.monotonic() + 15
    while not uv.started:
        if time.monotonic() > deadline:
            raise RuntimeError("the test server did not start")
        time.sleep(0.05)

    yield f"http://127.0.0.1:{port}"

    uv.should_exit = True
    thread.join(timeout=5)
    mp.undo()


@pytest.fixture
def open_page(page, live_server):
    """Open one of the editors, ready to be measured.

    Two things have to settle first or the geometry is a moving target. The
    viewport is pinned before navigating, since resizing a loaded page kicks off
    the ODT editor's re-pagination. And the web fonts have to arrive: until they
    do the pane header measures ~48px, then reflows to ~88px as the title and
    the buttons take their real width and wrap onto a second row.
    """

    def _open(path):
        page.set_viewport_size({"width": 1400, "height": 900})
        page.goto(live_server + path)
        expect(page.locator("#ai-pane .ai-title")).to_be_visible()
        page.evaluate("() => document.fonts.ready")
        return page

    return _open


def box(page, selector):
    b = page.locator(selector).bounding_box()
    assert b is not None, f"{selector} has no layout box"
    return b


def stable_box(page, selector, tries=20):
    """Measure only once the box has stopped moving.

    There is no single moment when this layout is settled: fonts arrive late
    (the pane header reflows from one row to two as they do) and the ODT editor
    re-paginates on a timer. Waiting on document.fonts.ready covers most of it,
    but a lone sample still occasionally catches the page mid-reflow — so read
    until two consecutive samples agree instead of trusting the first.
    """
    previous = None
    for _ in range(tries):
        current = box(page, selector)
        if previous is not None and all(
            abs(current[k] - previous[k]) < 0.5 for k in ("x", "y", "width", "height")
        ):
            return current
        previous = current
        page.wait_for_timeout(50)
    raise AssertionError(f"{selector} never stopped moving")


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("path", PAGES)
def test_composer_sits_at_the_bottom_of_the_pane(open_page, path):
    """The regression this file was written for.

    When #tab-panels is missing or the messages panel is not `.active`, the
    transcript collapses to nothing and the composer slides up under the header.
    """
    page = open_page(path)
    pane = stable_box(page, "#ai-pane")
    composer = stable_box(page, "#composer")
    header = stable_box(page, "#ai-pane .pane-header")

    assert composer["y"] + composer["height"] == pytest.approx(pane["y"] + pane["height"], abs=2)
    # …and it is at the far end of the pane, not stacked against the header.
    assert composer["y"] > header["y"] + header["height"] + 100


@pytest.mark.parametrize("path", PAGES)
def test_transcript_is_visible_and_fills_the_pane(open_page, path):
    page = open_page(path)
    expect(page.locator("#tab-panels .messages.active")).to_be_visible()

    panels = stable_box(page, "#tab-panels")
    header = stable_box(page, "#ai-pane .pane-header")
    composer = stable_box(page, "#composer")
    assert panels["height"] > 100
    assert panels["y"] >= header["y"] + header["height"] - 1
    assert panels["y"] + panels["height"] <= composer["y"] + 1


@pytest.mark.parametrize("path", PAGES)
def test_greeting_is_shown(open_page, path):
    page = open_page(path)
    expect(page.locator("#tab-panels .messages.active .msg.system")).to_contain_text("Assistant ready")


def test_both_editors_lay_the_pane_out_identically(open_page):
    """The point of sharing ai-pane.js: same width, same chrome, same geometry."""
    shapes = {}
    for path in PAGES:
        page = open_page(path)
        shapes[path] = {
            "pane_width": round(stable_box(page, "#ai-pane")["width"]),
            "divider_width": round(stable_box(page, "#divider")["width"]),
            "header_height": round(stable_box(page, "#ai-pane .pane-header")["height"]),
            "composer_height": round(stable_box(page, "#composer")["height"]),
        }
    assert shapes["/editor"] == shapes["/latex"]


@pytest.mark.parametrize("path", PAGES)
def test_pane_offers_the_same_controls(open_page, path):
    page = open_page(path)
    for selector in (
        "#model-select",
        '#ai-pane [data-act="add-model"]',
        '#ai-pane [data-act="skills"]',
        '#ai-pane [data-act="toggle-ai"]',
        "#tab-add",
        "#tab-list .tab",
        "#chat-input",
        "#send-btn",
    ):
        expect(page.locator(selector)).to_be_visible()


# ---------------------------------------------------------------------------
# Resize and collapse
# ---------------------------------------------------------------------------
def drag_divider(page, dx):
    d = box(page, "#divider")
    page.mouse.move(d["x"] + d["width"] / 2, d["y"] + d["height"] / 2)
    page.mouse.down()
    page.mouse.move(d["x"] + d["width"] / 2 + dx, d["y"] + d["height"] / 2, steps=8)
    page.mouse.up()


@pytest.mark.parametrize("path", PAGES)
def test_dragging_the_divider_resizes_the_pane(open_page, path):
    page = open_page(path)
    before = stable_box(page, "#ai-pane")["width"]
    drag_divider(page, -200)          # drag left => the AI pane grows
    after = stable_box(page, "#ai-pane")["width"]
    assert after == pytest.approx(before + 200, abs=12)


@pytest.mark.parametrize("path", PAGES)
def test_the_drag_is_clamped_at_both_ends(open_page, path):
    page = open_page(path)
    drag_divider(page, -2000)         # far past the left edge
    widened = stable_box(page, "#ai-pane")["width"]
    assert widened <= 1400 - 380 + 2, "the editor must keep its minimum width"

    drag_divider(page, 2000)          # far past the right edge
    assert stable_box(page, "#ai-pane")["width"] >= 300 - 2


@pytest.mark.parametrize("path", PAGES)
def test_collapsing_hides_the_pane_and_its_divider(open_page, path):
    page = open_page(path)
    page.locator('#ai-pane [data-act="toggle-ai"]').click()
    expect(page.locator("#ai-pane")).to_be_hidden()
    expect(page.locator("#divider")).to_be_hidden()

    page.locator("#toggle-ai").click()
    expect(page.locator("#ai-pane")).to_be_visible()
    expect(page.locator("#divider")).to_be_visible()


@pytest.mark.parametrize("path", PAGES)
def test_reopening_restores_the_dragged_width(open_page, path):
    page = open_page(path)
    drag_divider(page, -150)
    widened = stable_box(page, "#ai-pane")["width"]

    page.locator('#ai-pane [data-act="toggle-ai"]').click()
    page.locator("#toggle-ai").click()
    assert stable_box(page, "#ai-pane")["width"] == pytest.approx(widened, abs=2)


# ---------------------------------------------------------------------------
# Chat plumbing (no model is called: /help and /clear are handled in the browser)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("path", PAGES)
def test_slash_help_answers_in_the_transcript(open_page, path):
    page = open_page(path)
    page.fill("#chat-input", "/help")
    page.click("#send-btn")
    expect(page.locator("#tab-panels .messages.active")).to_contain_text("/clear")


@pytest.mark.parametrize("path", PAGES)
def test_new_tab_opens_its_own_transcript(open_page, path):
    page = open_page(path)
    expect(page.locator("#tab-panels .messages.active")).to_contain_text("Assistant ready")
    page.click("#tab-add")
    expect(page.locator("#tab-list .tab")).to_have_count(2)
    # One panel is shown at a time. A tab opened with the + button starts empty:
    # only /new announces itself, and that difference is the ODT editor's, kept.
    expect(page.locator("#tab-panels .messages.active")).to_have_count(1)
    expect(page.locator("#tab-panels .messages.active")).to_be_empty()

    page.locator("#tab-list .tab").first.click()   # back to the first chat
    expect(page.locator("#tab-panels .messages.active")).to_contain_text("Assistant ready")


@pytest.mark.parametrize("path", PAGES)
def test_skills_panel_opens_from_the_pane(open_page, path):
    page = open_page(path)
    page.locator('#ai-pane [data-act="skills"]').click()
    expect(page.locator("#skills-modal")).to_be_visible()
    page.locator('[data-act="close-skills"]').click()
    expect(page.locator("#skills-modal")).to_be_hidden()
