"""Tests for app.skills — Markdown-backed skill storage."""

from __future__ import annotations

from app import skills


def test_slugify():
    assert skills._slugify("My Skill!") == "my-skill"
    assert skills._slugify("  ") == "skill"  # fallback for empty


def test_create_and_get(tmp_skills):
    created = skills.create_skill("Writing Style", "Be concise.", "Tone guide")
    assert created.name == "Writing Style"
    assert created.description == "Tone guide"
    assert created.body == "Be concise."

    fetched = skills.get_skill("Writing Style")
    assert fetched is not None
    assert fetched.body == "Be concise."


def test_get_skill_case_insensitive_fallback(tmp_skills):
    skills.create_skill("Legal Review", "Check clauses.")
    assert skills.get_skill("legal review") is not None


def test_get_skill_missing_returns_none(tmp_skills):
    assert skills.get_skill("nope") is None


def test_list_skills_sorted(tmp_skills):
    skills.create_skill("Zebra", "z")
    skills.create_skill("Alpha", "a")
    names = [s.name for s in skills.list_skills()]
    assert names == ["Alpha", "Zebra"]


def test_frontmatter_overrides_name_and_description(tmp_skills, tmp_path):
    path = tmp_skills
    path.mkdir(parents=True, exist_ok=True)
    (path / "raw.md").write_text(
        "---\nname: Custom Name\ndescription: A desc\n---\n\nThe body.\n",
        encoding="utf-8",
    )
    skill = skills.get_skill("raw")
    assert skill.name == "Custom Name"
    assert skill.description == "A desc"
    assert skill.body == "The body."


def test_delete_skill(tmp_skills):
    skills.create_skill("Temp", "x")
    assert skills.delete_skill("Temp") is True
    assert skills.get_skill("Temp") is None
    assert skills.delete_skill("Temp") is False  # already gone


def test_compose_skill_prompt(tmp_skills):
    skills.create_skill("One", "First body")
    skills.create_skill("Two", "Second body")
    prompt = skills.compose_skill_prompt(["One", "Two", "Missing"])
    assert "## Skill: One" in prompt
    assert "First body" in prompt
    assert "## Skill: Two" in prompt
    assert "Missing" not in prompt  # unknown names silently skipped


def test_compose_skill_prompt_empty(tmp_skills):
    assert skills.compose_skill_prompt([]) == ""
