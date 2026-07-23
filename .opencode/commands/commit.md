---
description: Write commit message template from git diff (AGENTS.md convention)
---
Look at the current git changes and write a commit message following the AGENTS.md convention.

Steps:
1. Run `git diff --stat` and `git diff` to understand what changed.
2. Run `git status` to check for new/untracked files.
3. Read AGENTS.md section "Commit message template" for format rules.
4. Write a clear commit message (Vietnamese or English, complete sentences, what + why) into `.git/.git-o-commit-template`.
5. Do NOT run `git commit` — the user will do that manually.

The commit message should:
- Be concise (3-5 lines max for body)
- Describe what was changed and why
- Match the diff content exactly
- Not mention tools/agents unless user explicitly requested

$ARGUMENTS
