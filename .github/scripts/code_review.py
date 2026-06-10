"""AI Code Review script for GitHub Actions.
Reads a PR diff, sends it to Gemini API for review, outputs structured feedback."""

import os
import sys
import json
import httpx

SYSTEM_PROMPT = """You are a Staff Software Engineer conducting a code review at Google engineering standards.

## Review Checklist

### Design & Architecture
- Is the change well-scoped (one CL, one thing)?
- Does it fit the existing architecture or introduce unnecessary complexity?
- Is this the right time to add this change?

### Correctness & Bugs
- Logic errors, off-by-one, edge cases, null/exception paths
- Race conditions or concurrency issues
- Incorrect API usage or assumptions

### Security
- Injection vulnerabilities (shell, SQL, command, path traversal)
- Hardcoded secrets or credentials
- Unsafe deserialization or file operations

### Maintainability & Complexity
- Can it be simpler? Will others understand it quickly?
- Dead code, unused imports/variables
- Missing error handling or swallowed exceptions
- Comments explain Why, not What

### Testing
- Are there tests covering the change?
- Do tests follow 3A pattern (Arrange, Act, Assert)?
- Is there a regression test for bug fixes?
- Edge cases documented?

### Style & Convention
- Consistent with surrounding code and project style
- Names clearly express intent (variables, functions, classes)

## Severity Labels

| Prefix | Meaning |
|--------|---------|
| (none) | **Required** — must fix before LGTM |
| `Suggestion:` | Should consider seriously |
| `Nit:` | Minor polish, can ignore |

## Output Format

```
## 🔴 Required
- **file:line** — description
  Suggestion/fix

## 💡 Suggestions
- ...

## ✅ What Was Done Well
- ...

## Summary
Brief overall assessment.
```

## Rules
- Be specific: quote exact lines, suggest concrete fixes
- Prioritize: list required fixes first, suggestions second
- Praise good code too — say what was done right
- If no issues found, say "LGTM" with a brief summary
- Keep comments professional and constructive
- Remember: no perfect code, only better code"""


def read_diff(path: str) -> str:
    with open(path) as f:
        content = f.read()
    if not content.strip():
        return "(no diff)"
    return content


def call_gemini_api(api_key: str, diff: str, filename: str | None = None) -> str:
    file_context = f"\n\n## Files Changed\n{filename}" if filename else ""

    prompt = f"""Review the following code diff.

{file_context}

```diff
{diff}
```

Provide a thorough code review following the checklist above."""

    payload = {
        "contents": [{
            "parts": [
                {"text": SYSTEM_PROMPT},
                {"text": prompt},
            ]
        }],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 8192,
        }
    }

    response = httpx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-2.0-flash:generateContent",
        params={"key": api_key},
        headers={"Content-Type": "application/json"},
        json=payload,
        timeout=120,
    )
    response.raise_for_status()
    data = response.json()

    candidates = data.get("candidates", [])
    if not candidates:
        return "⚠️ Gemini API returned no candidates."

    text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
    return text if text else "⚠️ Empty response from Gemini."


def main():
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("⚠️ GOOGLE_API_KEY not available (fork PR from external contributor). Skipping AI review.")
        return

    if len(sys.argv) < 2:
        print("Usage: code_review.py <diff_file> [filename_pattern]", file=sys.stderr)
        sys.exit(1)

    diff_path = sys.argv[1]
    filename = sys.argv[2] if len(sys.argv) > 2 else None

    if not os.path.isfile(diff_path):
        print(f"❌ Diff file not found: {diff_path}", file=sys.stderr)
        sys.exit(1)

    diff = read_diff(diff_path)
    if diff == "(no diff)":
        print("✅ No diff to review.")
        return

    if len(diff) > 80000:
        diff = diff[:80000] + "\n... (truncated, diff too large)"

    try:
        review = call_gemini_api(api_key, diff, filename)
        print(review)
    except httpx.HTTPStatusError as e:
        print(f"❌ Gemini API error: {e.response.status_code} {e.response.text}", file=sys.stderr)
        sys.exit(1)
    except httpx.RequestError as e:
        print(f"❌ Network error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
