#!/usr/bin/env bash
# Map Codex inline review comments to a blog-engine ReviewResult JSON.
# stdin: JSON array of {body, path, line}. stdout: ReviewResult.
# Exit 0 when at least one P0/P1 issue exists; 2 when none (P2-only or empty).
set -euo pipefail
# python -c so JSON on stdin is the payload, not the program.
exec python3 -c "$(cat <<'PY'
import json
import re
import sys

raw = sys.stdin.read()
try:
    comments = json.loads(raw) if raw.strip() else []
except json.JSONDecodeError as e:
    sys.stderr.write(f"codex-comments-to-review: invalid JSON: {e}\n")
    sys.exit(1)
if not isinstance(comments, list):
    sys.stderr.write("codex-comments-to-review: expected a JSON array\n")
    sys.exit(1)

P0 = re.compile(r"badge/P0-|P0 Badge", re.I)
P1 = re.compile(r"badge/P1-|P1 Badge", re.I)
P2 = re.compile(r"badge/P2-|P2 Badge", re.I)
HTML = re.compile(r"<[^>]+>")
MD_IMG = re.compile(r"!\[[^\]]*\]\([^)]*\)")
FOOTER = re.compile(r"Useful\?\s*React[\s\S]*$", re.I)
BOLD = re.compile(r"\*\*")

def severity_of(body: str) -> str | None:
    if P0.search(body):
        return "blocker"
    if P1.search(body):
        return "major"
    if P2.search(body):
        return None
    return None

def clean(body: str) -> tuple[str, str]:
    text = HTML.sub("", body)
    text = MD_IMG.sub("", text)
    text = FOOTER.sub("", text)
    text = BOLD.sub("", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = text.strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return "Codex finding", ""
    title = lines[0]
    rest = "\n".join(lines[1:]).strip()
    return title, rest

issues = []
for c in comments:
    if not isinstance(c, dict):
        continue
    body = c.get("body") or ""
    if not isinstance(body, str):
        continue
    sev = severity_of(body)
    if sev is None:
        continue
    message, suggestion = clean(body)
    path = c.get("path") or ""
    line = c.get("line")
    location = None
    if path:
        location = f"{path}:{line}" if line is not None else str(path)
    issue = {
        "dimension": "contentQuality",
        "severity": sev,
        "message": message,
        "suggestion": suggestion or message,
    }
    if location:
        issue["location"] = location
    issues.append(issue)

has_issues = len(issues) > 0
result = {
    "pass": not has_issues,
    "overallScore": 0,
    "scores": [
        {
            "dimension": "contentQuality",
            "score": 0,
            "reasoning": "Codex P0/P1 hold — not an AI-review score.",
        }
    ],
    "issues": issues,
    "suggestions": [],
    "summary": (
        "Codex left P0/P1 findings that block autoblog merge. Fix only those issues."
        if has_issues
        else "No unresolved Codex P0/P1 findings."
    ),
    "thresholdReasoning": (
        "Codex P0/P1 only. Do not restyle. Do not apply P2 nits. Do not rewrite from scratch."
    ),
    "modelUsed": "chatgpt-codex-connector",
}
sys.stdout.write(json.dumps(result, indent=2) + "\n")
sys.exit(0 if has_issues else 2)
PY
)"
