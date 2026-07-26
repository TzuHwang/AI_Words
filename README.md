# AI Words

**English** · [繁體中文](README.zh-TW.md)

> A document editor with a streaming AI assistant built into the right pane: LibreOffice-style rich text for `.odt`, and a LaTeX source editor with a live PDF preview for `.tex`.
> Open a document, edit it directly in the browser (with or without AI help), and export or compile it when you're done.

<p>
  <img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-blue">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-async-009688">
  <img alt="Status" src="https://img.shields.io/badge/status-MVP-orange">
</p>

---

## Table of Contents

- [Introduction](#introduction)
- [Inspiration](#inspiration)
- [Features](#features)
- [Project Structure](#project-structure)
- [Getting Started from Scratch](#getting-started-from-scratch)
- [Configuring AI Models](#configuring-ai-models)
- [Usage](#usage)
- [Adding LaTeX Templates](#adding-latex-templates)
- [Running the Tests](#running-the-tests)
- [Packaging as an Executable](#packaging-as-an-executable)
- [Roadmap](#roadmap)
- [License](#license)

---

## Introduction

**AI Words** is a standalone, runnable desktop application. On launch it opens a web page in your browser: a launcher that hands an opened file to whichever editor suits it, chosen by extension.

- **Rich text** (`/editor`) — an editing area modeled on the Word / LibreOffice writing experience, for `.odt` and `.html`.
- **LaTeX** (`/latex`) — a `.tex` source pane that compiles on the server and previews the PDF in its own browser tab.
- **AI assistant** — the same streaming, command-driven chat pane down the right of both, inspired by *Claude Code for VS Code*.

The rich-text pipeline has three steps:

1. **Import:** load an ODT file and render it to HTML for display and editing.
2. **Edit:** the user (and/or the AI assistant) modifies the HTML content in the browser.
3. **Export:** on save, serialize the edited HTML back to ODT (or other formats).

LaTeX skips the conversion entirely — the source *is* the document, and an installed engine turns it into the PDF you preview. That engine is optional: without one the editor and the assistant still work, you just don't get a preview.

The goal is to let you open a document, edit it directly in the browser (with or without AI assistance), and export or compile the result when finished.

ODT conversion is pure-Python (`odfpy`) by default; if a LibreOffice `soffice` binary is found on the system, it is used automatically for higher-fidelity conversion.

## Inspiration

The idea originated from [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — the concept of handing office documents to an AI agent to read and edit.

The right-pane assistant's interaction style follows *Claude Code for VS Code*: a lightweight, command-driven chat interface where you switch models, load skills, and ask the agent to read and edit the current document via slash commands.

## Features

- 🖥️ **Single-executable launch** — starts and opens the editor in your browser.
- 🚦 **Two editors, one launcher** — rich text for `.odt`, LaTeX for `.tex`; opening a file routes by extension.
- 📄 **ODT ⇄ HTML** — import ODT rendered to editable HTML, export back to ODT / HTML on save.
- ✍️ **Rich-text editing** — bold / italic / underline, headings, and lists via the toolbar.
- 📐 **LaTeX with a live PDF preview** — auto-compiles as you type via an installed engine (tectonic, xelatex, …) and redraws the PDF in its own tab without losing your place. Optional: without an engine the editor still runs.
- 🤖 **Streaming AI assistant** — the same pane in both editors; supports the Anthropic API and any OpenAI-compatible local server (Ollama, LM Studio, …).
- 🔀 **Model switching** — switch local/cloud models live from a dropdown or with `/model <id>`.
- 🧩 **Skills** — create and load reusable instruction / tool bundles.
- 🧠 **Reasoning-model support** — `<think>…</think>` reasoning is stripped from the chat display automatically.

## Project Structure

```text
AI_Words/
├── run.py                  # Convenience launcher: python run.py (same as python -m app)
├── run.sh                  # Build the Docker image and start the app in a container
├── pyproject.toml          # Poetry project config & dependencies
├── Dockerfile              # Runtime image, plus test / test-tex / test-ui targets
├── config.json             # Created on first run: model backends & active selections
├── LICENSE
│
├── app/                    # Application package
│   ├── __main__.py         # CLI entry point: parse args, start uvicorn, open browser
│   ├── server.py           # FastAPI: pages + JSON/SSE API
│   ├── converter.py        # ODT ⇄ HTML (odfpy; optional LibreOffice)
│   ├── latex.py            # .tex → PDF via an installed LaTeX engine (optional)
│   ├── ai.py               # Streaming chat (Anthropic + OpenAI-compatible backends)
│   ├── config.py           # Model backends & active-selection management
│   ├── skills.py           # Skill storage/loading (skills/*.md)
│   └── static/             # Web UI — one page per editor, one shared assistant
│       ├── launcher.html   # Landing page at /          (+ launcher.css/.js)
│       ├── index.html      # Rich-text editor at /editor (+ app.js)
│       ├── latex.html      # LaTeX editor at /latex      (+ latex.css/.js)
│       ├── pdfview.html    # PDF preview tab             (+ pdfview.css/.js)
│       ├── ai-pane.js      # The AI assistant pane, shared by both editors
│       ├── ui.js           # $, escapeHtml, and the in-page dialogs
│       ├── style.css       # Shared chrome
│       └── vendor/         # pdf.js (Apache-2.0), vendored to work offline
│
├── skills/                 # Skill definitions (Markdown)
│   ├── incremental-edits.md
│   └── language-consistency.md
│
└── tests/                  # pytest; the browser tests live in test_ui.py
```

**Data-flow overview:**

```text
Browser UI (app/static)
      │  HTTP / SSE
      ▼
FastAPI (app/server.py)
      ├── converter.py  ── ODT ⇄ HTML
      ├── latex.py      ── .tex → PDF
      ├── ai.py         ── streams to Anthropic / local models
      ├── config.py     ── reads/writes config.json
      └── skills.py     ── reads skills/*.md
```

## Getting Started from Scratch

### Prerequisites

- **Python 3.10+** (developed on 3.14).
- **[Poetry](https://python-poetry.org/)** for dependency management.
- (Optional) **An API key or a local model** — the AI assistant needs one of these to respond:
  - Cloud: set the `ANTHROPIC_API_KEY` environment variable.
  - Local: a running [Ollama](https://ollama.com) or any OpenAI-compatible server.

### Step 1 — Get the source

```bash
git clone <this-repo-url>
cd AI_Words
```

### Step 2 — Install dependencies

```bash
poetry install          # create a virtualenv and install dependencies
```

### Step 3 — (Optional) Configure an AI key

To use Anthropic cloud models, set your key first:

```bash
# macOS / Linux
export ANTHROPIC_API_KEY=sk-...

# Windows (PowerShell)
$env:ANTHROPIC_API_KEY = "sk-..."
```

If no key is set, the app automatically selects a reachable local model so it works out of the box.

### Step 4 — Launch

```bash
poetry run ai-words     # start the server and open the editor in your browser
```

`poetry run ai-words` is the packaged entry point; `poetry run python run.py` is equivalent.
The app serves at `http://127.0.0.1:8765/`. Options:

```bash
poetry run ai-words --port 9000     # use a different port
poetry run ai-words --no-browser    # don't auto-open a browser
poetry run ai-words --host 0.0.0.0  # expose to the network (default is local only)
poetry run ai-words --reload        # auto-reload on source changes (development)
```

### Run with Docker (alternative)

The image bakes in a LaTeX engine and CJK fonts so the PDF preview works out of the box, but leaves out LibreOffice — ODT conversion falls back to pure Python — which keeps it under 1 GB:

```bash
docker build -t ai-words .
docker run --rm -p 8765:8765 -e ANTHROPIC_API_KEY=sk-... ai-words
```

Then open `http://127.0.0.1:8765/`. Model/skill state lives in `/data`; mount a named volume there to persist it across container restarts:

```bash
docker run --rm -p 8765:8765 -e ANTHROPIC_API_KEY=sk-... -v ai-words-data:/data ai-words
```

For higher-fidelity ODT conversion via LibreOffice, uncomment the `libreoffice-writer` block in the [`Dockerfile`](Dockerfile).

## Configuring AI Models

On first run a `config.json` is created with these model backends:

- **Claude Opus 4.8** / **Claude Haiku 4.5** — via the Anthropic API. Set the `ANTHROPIC_API_KEY` environment variable to use them.
- **Local models** — on first run, if [Ollama](https://ollama.com) is running, its installed models are **discovered once** and added to the list. After that you manage models explicitly in the UI (add/remove), so changes stick. Any OpenAI-compatible server (Ollama, LM Studio, …) works.

If no API key is set, the app automatically selects a reachable local model so it works out of the box. You can:

- Switch models from the dropdown in the assistant pane, or with `/model <id>`.
- Add your own backend by editing `config.json` (or calling `POST /api/models`).

> Reasoning models (qwen, deepseek-r1, …) that emit `<think>…</think>` are supported — the reasoning is stripped from the chat display automatically.

## Usage

- **Open** an `.odt` (or `.html`) file from the toolbar → it renders into the editor.
- **Edit** directly in the left pane; use the toolbar for bold/italic/underline, headings, and lists.
- **Ask the assistant** (right pane) to read or edit the document. When it proposes a change it returns the full revised document; click **Apply to document** to accept it.
- **Save** as ODT or HTML from the Save menu.

Assistant slash commands:

| Command | Description |
| --- | --- |
| `/help` | Show available commands |
| `/models` | List available models |
| `/model <id>` | Switch to a model |
| `/skills` | List skills |
| `/skill new <name>` | Create a new skill |
| `/skill load <name>` | Load a skill |
| `/clear` | Clear the conversation |

## Adding LaTeX Templates

The image ships `texlive-latex-recommended` and `texlive-latex-extra`, which cover `article`, `report`, `book`, `beamer` and around 280 other classes — but not the journal templates, which live in collections too large to bake in. `IEEEtran`, `acmart`, `elsarticle` and `revtex` are all absent. A document asking for one fails to compile, and the log says which file it wanted:

```
! LaTeX Error: File `IEEEtran.cls' not found.
```

Rather than rebuild the image, drop the class or package into `TEXMFHOME`, which the container points at **`/data/texmf`** — the volume you are already mounting for models and skills, so a template survives a restart like the rest of your state. The system tree under `/usr/share/texlive` is read-only to the app's user, and Debian's `tlmgr` refuses to install into it, so this is the way in.

The one rule is that files must sit somewhere under **`tex/`**. Below that the layout is free — `kpathsea` searches the whole tree at any depth — but a file left at the root of `texmf/` is not found:

```
/data/texmf/
└── tex/
    └── latex/
        └── ieeetran/
            └── IEEEtran.cls      ✅ found
/data/texmf/
└── IEEEtran.cls                  ❌ not found
```

With a named volume, copy the files in and restart:

```bash
docker cp IEEEtran.cls $(docker ps -qf ancestor=ai-words):/data/texmf/tex/latex/ieeetran/
```

Or bind-mount a directory you keep on the host, which is easier to maintain:

```bash
mkdir -p ./ai-words-data/texmf/tex/latex/ieeetran
cp IEEEtran.cls ./ai-words-data/texmf/tex/latex/ieeetran/
docker run --rm -p 8765:8765 -v ./ai-words-data:/data ai-words
```

`.sty` packages work the same way, as do `.bst` styles and font files — anything `kpathsea` looks up. No index needs rebuilding: `TEXMFHOME` is scanned live, so a file is picked up on the next compile with no restart.

Running outside Docker, `TEXMFHOME` is wherever your TeX distribution puts it — `~/texmf` on Linux and macOS, `~/.texlive/texmf-home` on some setups. Check with:

```bash
kpsewhich -var-value=TEXMFHOME
```

If you would rather have a template available to everyone without a volume, install it into the image instead: add the relevant TeX Live package (`texlive-publishers` covers IEEEtran, `elsarticle` and `revtex`; `texlive-science` covers much of the maths and physics set) to the `texlive` stage in the [`Dockerfile`](Dockerfile) and rebuild.

## Running the Tests

```bash
poetry install          # includes the dev group (pytest)
poetry run pytest
```

The suite stubs out every external tool, so it needs neither an AI key nor LibreOffice nor a LaTeX engine nor a browser. Anything that does need one of those **skips** rather than fails, so a bare `pytest` is always green. Three Docker targets supply the missing pieces:

```bash
# The suite as above, on the project's Python version.
docker build --target test -t ai-words-test . && docker run --rm ai-words-test

# The same, plus a real LaTeX engine (xelatex + CJK fonts).
docker build --target test-tex -t ai-words-test-tex . && docker run --rm ai-words-test-tex

# The same, plus Chromium, for the browser tests.
docker build --target test-ui -t ai-words-test-ui . && docker run --rm ai-words-test-ui
```

`tests/test_latex_engine.py` compiles actual documents — cross references resolving from a reused `.aux`, a broken document reporting its log, a CJK document finding its fonts. It skips when no engine is on `PATH`.

`tests/test_ui.py` drives both editors in real Chromium, because nothing else in the suite can see layout: it checks that the AI pane is laid out identically on `/editor` and `/latex`, that the transcript is visible and the composer sits at the bottom, and that the divider drag and collapse behave the same on both. It skips unless a browser is installed. To run it outside Docker, fetch one once:

```bash
poetry run playwright install chromium
```

None of this reaches the deployed image: `runtime` copies its virtualenv from the `builder` stage, which installs `--only main`, so the dev group — pytest, Playwright and all — is never in it.

## Packaging as an Executable

The launcher and web UI have no build step, so a single-file executable can be produced with PyInstaller:

```bash
pyinstaller --onefile --add-data "app/static:app/static" --name ai_words run.py
```

## Roadmap

- [x] Executable that launches and serves the local web UI
- [x] Two-pane layout (editor + AI assistant)
- [x] ODT → HTML rendering (import)
- [x] Rich-text editing in the browser
- [x] HTML → ODT export (save)
- [x] AI chat interface with model switching (local + API backends)
- [x] Skill creation and loading
- [x] Agent-driven document read/edit (propose-and-apply)
- [x] LaTeX editor: write `.tex`, compile it server-side, and preview the PDF
- [ ] **LaTeX export:** convert an open ODT / HTML document into `.tex`. The editor above authors LaTeX directly; there is no conversion from a rich-text document yet.
- [ ] Higher-fidelity ODT conversion (images, styles, nested lists)
- [ ] Live / tool-based editing instead of full-document replacement
- [ ] **Real agent harness (WIP):** an agentic tool-use loop — define `read_document` / `apply_edit` tools, let the model call them, execute them server-side, and feed results back so the model can iterate multi-step. Today the assistant is single-turn propose-and-apply (the user manually accepts a full-document rewrite), so it's a chat orchestration layer, not yet a true agent harness.
- [ ] Package and ship prebuilt executables

## License

See [LICENSE](LICENSE).

`app/static/vendor/` bundles [pdf.js](https://github.com/mozilla/pdf.js) (Mozilla, Apache-2.0),
which renders the LaTeX PDF preview.
