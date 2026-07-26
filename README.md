# AI Words

**English** · [繁體中文](README.zh-TW.md)

> A LibreOffice-style ODT document editor with a streaming AI assistant built into the right pane.
> Open a document, edit it directly in the browser (with or without AI help), and export it back to a file when you're done.

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
- [Running the Tests](#running-the-tests)
- [Packaging as an Executable](#packaging-as-an-executable)
- [Roadmap](#roadmap)
- [License](#license)

---

## Introduction

**AI Words** is a standalone, runnable desktop application. On launch it opens a web page in your browser, split into two panes:

- **Left — Document editor:** a rich-text editing area modeled on the Word / LibreOffice writing experience.
- **Right — AI assistant:** a command-driven chat interface for driving edits, inspired by *Claude Code for VS Code*.

The core document pipeline has three steps:

1. **Import:** load an ODT file and render it to HTML for display and editing.
2. **Edit:** the user (and/or the AI assistant) modifies the HTML content in the browser.
3. **Export:** on save, serialize the edited HTML back to ODT (or other formats).

The goal is to let you open a document, edit it directly in the browser (with or without AI assistance), and export the result back to a file when finished.

ODT conversion is pure-Python (`odfpy`) by default; if a LibreOffice `soffice` binary is found on the system, it is used automatically for higher-fidelity conversion.

## Inspiration

The idea originated from [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — the concept of handing office documents to an AI agent to read and edit.

The right-pane assistant's interaction style follows *Claude Code for VS Code*: a lightweight, command-driven chat interface where you switch models, load skills, and ask the agent to read and edit the current document via slash commands.

## Features

- 🖥️ **Single-executable launch** — starts and opens the two-pane editor in your browser.
- 📄 **ODT ⇄ HTML** — import ODT rendered to editable HTML, export back to ODT / HTML on save.
- ✍️ **Rich-text editing** — bold / italic / underline, headings, and lists via the toolbar.
- 🤖 **Streaming AI assistant** — supports the Anthropic API and any OpenAI-compatible local server (Ollama, LM Studio, …).
- 🔀 **Model switching** — switch local/cloud models live from a dropdown or with `/model <id>`.
- 🧩 **Skills** — create and load reusable instruction / tool bundles.
- 🧠 **Reasoning-model support** — `<think>…</think>` reasoning is stripped from the chat display automatically.

## Project Structure

```text
AI_Words/
├── run.py                  # Convenience launcher: python run.py (same as python -m app)
├── pyproject.toml          # Poetry project config & dependencies
├── Dockerfile              # Slim, pure-Python image (no LibreOffice)
├── config.json             # Created on first run: model backends & active selections
├── LICENSE
│
├── app/                    # Application package
│   ├── __main__.py         # CLI entry point: parse args, start uvicorn, open browser
│   ├── server.py           # FastAPI: pages + JSON/SSE API
│   ├── converter.py        # ODT ⇄ HTML (odfpy; optional LibreOffice)
│   ├── ai.py               # Streaming chat (Anthropic + OpenAI-compatible backends)
│   ├── config.py           # Model backends & active-selection management
│   ├── skills.py           # Skill storage/loading (skills/*.md)
│   └── static/             # Two-pane web UI
│       ├── index.html
│       ├── style.css
│       └── app.js
│
└── skills/                 # Skill definitions (Markdown)
    └── language-consistency.md
```

**Data-flow overview:**

```text
Browser UI (app/static)
      │  HTTP / SSE
      ▼
FastAPI (app/server.py)
      ├── converter.py  ── ODT ⇄ HTML
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

The image runs the pure-Python build (no LibreOffice), so it stays slim:

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

## Running the Tests

```bash
poetry install          # includes the dev group (pytest)
poetry run pytest
```

The suite stubs out every external tool, so it needs neither an AI key nor LibreOffice nor a LaTeX engine. Two Docker targets run it in a clean environment:

```bash
# The suite as above, on the project's Python version.
docker build --target test -t ai-words-test . && docker run --rm ai-words-test

# The same, plus a real LaTeX engine (xelatex + CJK fonts).
docker build --target test-tex -t ai-words-test-tex . && docker run --rm ai-words-test-tex
```

`tests/test_latex_engine.py` compiles actual documents — cross references resolving from a reused `.aux`, a broken document reporting its log, a CJK document finding its fonts. Those tests **skip** when no engine is on `PATH`, which is why the `test-tex` target exists; the plain `test` target skips them just like a bare machine does.

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
- [ ] **LaTeX export/write support (WIP):** let documents be exported / written to LaTeX format.
- [ ] Higher-fidelity ODT conversion (images, styles, nested lists)
- [ ] Live / tool-based editing instead of full-document replacement
- [ ] **Real agent harness (WIP):** an agentic tool-use loop — define `read_document` / `apply_edit` tools, let the model call them, execute them server-side, and feed results back so the model can iterate multi-step. Today the assistant is single-turn propose-and-apply (the user manually accepts a full-document rewrite), so it's a chat orchestration layer, not yet a true agent harness.
- [ ] Package and ship prebuilt executables

## License

See [LICENSE](LICENSE).

`app/static/vendor/` bundles [pdf.js](https://github.com/mozilla/pdf.js) (Mozilla, Apache-2.0),
which renders the LaTeX PDF preview.
