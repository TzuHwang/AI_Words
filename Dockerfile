# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Builder — resolve and install dependencies into a dedicated virtualenv
# ---------------------------------------------------------------------------
FROM python:3.14-slim AS builder

ENV POETRY_VERSION=2.0.1 \
    POETRY_NO_INTERACTION=1 \
    POETRY_VIRTUALENVS_CREATE=false \
    PIP_NO_CACHE_DIR=1

# curl is needed by the Poetry installer; ca-certificates for HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 1. Set up the project virtualenv and put it first on PATH so 'python'/'pip'
#    resolve to it — Poetry (with virtualenvs.create=false) installs into it.
ENV VIRTUAL_ENV=/venv/default
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:/root/.local/bin:$PATH"

# 2. Install Poetry via the official installer (isolated in /root/.local),
#    pinned to a specific version.
RUN curl -sSL https://install.python-poetry.org | python3 - --version $POETRY_VERSION

WORKDIR /app

# Dependencies first (cached across source edits).
COPY pyproject.toml poetry.lock* ./
RUN poetry install --only main --no-root

# Then the app package itself.
COPY app ./app
COPY README.md ./
RUN poetry install --only main

# ---------------------------------------------------------------------------
# Test — dev dependencies + test suite, layered on the builder. Not part of the
# runtime image. Build/run with:
#   docker build --target test -t ai-words-test .
#   docker run --rm ai-words-test
# ---------------------------------------------------------------------------
FROM builder AS test
# Add the dev group (pytest) on top of the main deps already installed.
RUN poetry install --with dev
COPY tests ./tests
CMD ["python", "-m", "pytest", "-q"]

# ---------------------------------------------------------------------------
# Test (browser) — the same suite with Chromium installed, so the layout tests
# in test_ui.py (skipped without a browser) actually run. `--with-deps` pulls
# the shared libraries Chromium needs on a slim image, which is most of the
# ~400MB this target adds over `test`. Build/run with:
#   docker build --target test-ui -t ai-words-test-ui .
#   docker run --rm ai-words-test-ui
# ---------------------------------------------------------------------------
FROM test AS test-ui
RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
CMD ["python", "-m", "pytest", "-q"]

# ---------------------------------------------------------------------------
# TeX — the LaTeX engine layer. Shared by the runtime image and the engine
# tests below so this (~1GB) apt install is built and cached once.
#
# xetex (not pdflatex) plus the CJK fonts so Traditional/Simplified Chinese
# documents compile — the app's font picker is CJK-first. Baked into the image
# so the preview works offline and out of the box; without it the LaTeX editor
# still runs but shows a "no compiler" notice. Drop the texlive-lang-chinese /
# fonts-noto-cjk packages if you don't need CJK.
#
# XeTeX resolves fonts through fontconfig, and scanning the CJK families is slow
# enough to dominate a first compile. `fc-cache -fs` builds the *system* cache
# (/var/cache/fontconfig) at build time so it ships inside the image: the app
# user reads it instead of rebuilding a private one in $HOME on every fresh
# container. --system-only matters — a plain `fc-cache -f` as root would write
# to /root/.cache, which appuser can't read.
# ---------------------------------------------------------------------------
FROM python:3.14-slim AS texlive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       texlive-xetex texlive-latex-recommended texlive-latex-extra \
       texlive-lang-chinese fonts-noto-cjk fontconfig \
    && fc-cache -fs \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Test (engine) — the same suite with a real LaTeX engine on PATH, so the
# tests in test_latex_engine.py (skipped on a machine without one) actually
# run. Build/run with:
#   docker build --target test-tex -t ai-words-test-tex .
#   docker run --rm ai-words-test-tex
# ---------------------------------------------------------------------------
FROM texlive AS test-tex
ENV VIRTUAL_ENV=/venv/default \
    PATH="/venv/default/bin:$PATH"
WORKDIR /app
COPY --from=test /venv/default /venv/default
COPY pyproject.toml ./
COPY app ./app
COPY tests ./tests
CMD ["python", "-m", "pytest", "-q"]

# ---------------------------------------------------------------------------
# Runtime — slim image containing just the venv and the app
# ---------------------------------------------------------------------------
FROM texlive AS runtime

# Persist mutable state (config + skills) under /data so a single mounted volume
# survives restarts without shadowing the app code in /app.
ENV PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/venv/default \
    PATH="/venv/default/bin:$PATH" \
    AI_WORDS_CONFIG=/data/config.json \
    AI_WORDS_SKILLS=/data/skills

# --- Optional: LibreOffice for higher-fidelity ODT import/export (~1GB).
#     The app works without it via a pure-Python (odfpy) fallback, so it is
#     left out by default. Uncomment to enable higher-fidelity conversion:
# RUN apt-get update \
#     && apt-get install -y --no-install-recommends libreoffice-writer \
#     && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 appuser \
    && mkdir -p /app /data/skills \
    && chown -R appuser:appuser /app /data
WORKDIR /app

COPY --chown=appuser:appuser --from=builder /venv/default /venv/default
COPY --chown=appuser:appuser --from=builder /app/app ./app
# Seed the default skills into /data so a fresh named volume is populated with
# them on first mount (Docker copies image contents into empty named volumes).
COPY --chown=appuser:appuser skills /data/skills

USER appuser

EXPOSE 8765
VOLUME ["/data"]

# Bind to all interfaces so the container is reachable from the host; a browser
# can't be opened from inside a container, so disable that.
CMD ["python", "-m", "app", "--host", "0.0.0.0", "--no-browser"]
