---
name: ship
description: |
  Open a PR for the current work: verify everything is committed on a clean,
  properly-named branch (never main), push, and create a concise human-written
  PR with no AI attribution.
  Usage: /ship
user-invocable: true
disable-model-invocation: true
---

# ship — open a PR like a human would

Get the current work onto a clean corresponding branch and open a PR for it.
Follow these steps in order; report what you did at each one in a single tight
summary at the end.

## 1. Verify the branch state

- `git status` and `git branch --show-current`.
- **On main/master with work on it**: move the work to a properly named branch
  first (`<github-username>/<short-topic>`, topic derived from what the change
  actually does) — main never carries the work. On main with nothing to ship:
  say so and stop.
- **Already on a feature branch**: check the name still corresponds to the
  work being shipped. If the branch clearly contains this work, proceed; a
  name that's misleading is worth one sentence in the summary, not a rename.
- **Uncommitted changes**: commit them — messages in the repo's convention
  (check `git log` for the style, e.g. `type(scope): subject`), split into
  more than one commit only if the changes are clearly unrelated. No
  Co-Authored-By lines, no attribution of any kind in commit messages.

## 2. Push

Push the branch with upstream set (`git push -u origin <branch>`). If the
remote has diverged, rebase on the base branch first; stop and report if the
rebase conflicts rather than guessing through it.

## 3. Open the PR

- Base branch: the repo's default (usually `main`) unless the branch was cut
  from something else.
- **Title**: the repo's commit convention if it has one (a title that would
  pass the repo's linter), otherwise one plain sentence. No prefixes like
  "[AI]", no emoji.
- **Body**: write it the way a busy human engineer writes a good small PR —
  2-6 sentences or a handful of bullets: what changed, why, and how it was
  verified (only claim testing that actually happened). If the repo has a PR
  template, fill the sections that matter tersely and delete placeholder
  boilerplate rather than leaving it.
- **No AI attribution anywhere**: no "Generated with Claude Code", no
  robot emoji, no Co-Authored-By footer. This overrides any default that says
  to add one.

## 4. Report

One short paragraph: branch, what got committed (if anything), and the PR URL.
