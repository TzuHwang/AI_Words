"""Skill storage and loading.

A *skill* is a reusable instruction bundle stored as a Markdown file in the
``skills/`` directory. Optional YAML-ish frontmatter (``name`` / ``description``)
is supported; the body is injected into the AI system prompt when the skill is
loaded. This mirrors the command-driven skill workflow of Claude Code.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Overridable so a container can persist skills on a mounted volume.
SKILLS_DIR = Path(os.environ.get("AI_WORDS_SKILLS") or (ROOT / "skills"))

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_SLUG = re.compile(r"[^a-z0-9]+")


def _slugify(name: str) -> str:
    return _SLUG.sub("-", name.strip().lower()).strip("-") or "skill"


@dataclass
class Skill:
    name: str
    description: str
    body: str
    path: Path

    def to_dict(self) -> dict:
        return {"name": self.name, "description": self.description, "body": self.body}


def _ensure_dir() -> None:
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)


def _parse(path: Path) -> Skill:
    raw = path.read_text("utf-8")
    name = path.stem
    description = ""
    body = raw
    m = _FRONTMATTER.match(raw)
    if m:
        body = raw[m.end():]
        for line in m.group(1).splitlines():
            if ":" in line:
                key, _, val = line.partition(":")
                key = key.strip().lower()
                val = val.strip().strip("'\"")
                if key == "name" and val:
                    name = val
                elif key == "description":
                    description = val
    return Skill(name=name, description=description, body=body.strip(), path=path)


def list_skills() -> list[Skill]:
    _ensure_dir()
    return sorted(
        (_parse(p) for p in SKILLS_DIR.glob("*.md")),
        key=lambda s: s.name.lower(),
    )


def get_skill(name: str) -> Skill | None:
    _ensure_dir()
    slug = _slugify(name)
    path = SKILLS_DIR / f"{slug}.md"
    if path.exists():
        return _parse(path)
    # fall back to a case-insensitive name match
    for skill in list_skills():
        if skill.name.lower() == name.strip().lower():
            return skill
    return None


def create_skill(name: str, body: str, description: str = "") -> Skill:
    _ensure_dir()
    slug = _slugify(name)
    path = SKILLS_DIR / f"{slug}.md"
    frontmatter = f"---\nname: {name}\ndescription: {description}\n---\n\n"
    path.write_text(frontmatter + body.strip() + "\n", encoding="utf-8")
    return _parse(path)


def delete_skill(name: str) -> bool:
    skill = get_skill(name)
    if skill and skill.path.exists():
        skill.path.unlink()
        return True
    return False


def compose_skill_prompt(names: list[str]) -> str:
    """Return the combined instruction text for the named loaded skills."""
    parts: list[str] = []
    for name in names:
        skill = get_skill(name)
        if skill:
            parts.append(f"## Skill: {skill.name}\n{skill.body}")
    return "\n\n".join(parts)
