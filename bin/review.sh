#!/bin/bash
#
# Review action for claude-micro. Spawned in its own tmux window by the daemon
# when an action key bound to "review" is pressed.
#
# Picks its own target, because the useful thing to review depends on where the
# branch is. Exactly three cases, in precedence order:
#
#   1. text typed in the pane's composer -> that PR number, PR URL, or branch
#   2. uncommitted changes               -> the working diff
#   3. clean tree, branch ahead of base  -> its PR if one exists, else the branch
#
# A fourth outcome is "nothing to review", which is reported rather than
# treated as an error.
#
# usage: review.sh <keyId> <windowId> <panePath> <typedText> [effort]
set -uo pipefail

KEY="${1:?key id required}"
# The daemon can't know the window id before creating the window that runs this,
# so discover it from the pane we're in when it isn't passed.
WINDOW="${2:-}"
[ -z "$WINDOW" ] && WINDOW="$(tmux display-message -p -t "${TMUX_PANE:-}" '#{window_id}' 2>/dev/null || true)"
DIR="${3:?pane path required}"
TYPED="${4:-}"
EFFORT="${5:-high}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HERE/actions/$KEY.json"
REPORTS="$HERE/reports"
mkdir -p "$HERE/actions" "$REPORTS"

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
REPORT=""

# Written for the daemon to read; it drives this key's LED.
set_state() {
  STATUS="$1" NOTE="${2:-}" KEY="$KEY" WINDOW="$WINDOW" REPORT="$REPORT" TARGET="${DESC:-}" \
  STATE="$STATE" python3 - <<'PY'
import json, os, time
path = os.environ['STATE']
tmp = path + '.tmp'
with open(tmp, 'w') as fh:
    json.dump({
        'key': os.environ['KEY'],
        'status': os.environ['STATUS'],
        'note': os.environ['NOTE'],
        'window': os.environ['WINDOW'],
        'report': os.environ['REPORT'],
        'target': os.environ['TARGET'],
        'at': int(time.time() * 1000),
    }, fh)
os.replace(tmp, path)
PY
}

banner() { printf '\033[1;34m%s\033[0m\n' "$*"; }
fail()   { printf '\033[1;31m%s\033[0m\n' "$*"; }

ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ]; then
  DESC="not a git repository"
  fail "not a git repository: $DIR"
  set_state error "not a git repository"
  sleep 5
  exit 1
fi
cd "$ROOT" || exit 1
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"

TARGET=""
DESC=""
if [ -n "$TYPED" ]; then
  # Case 1: the composer names what to review, so it's a remote branch or PR.
  if [[ "$TYPED" =~ ^#?([0-9]+)$ ]]; then
    TARGET="${BASH_REMATCH[1]}"; DESC="PR #$TARGET"
  elif [[ "$TYPED" =~ ^https?:// ]]; then
    TARGET="$TYPED"; DESC="$TYPED"
  else
    TARGET="$TYPED"; DESC="branch $TYPED"
  fi
elif [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  # Case 2: work in progress beats anything already pushed.
  TARGET=""; DESC="uncommitted changes on $BRANCH"
else
  # Case 3: nothing local, so review what the branch has published.
  PR="$(gh pr view --json number -q .number 2>/dev/null)"
  if [ -n "$PR" ]; then
    TARGET="$PR"; DESC="PR #$PR ($BRANCH)"
  else
    BASE="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
    BASE="${BASE:-main}"
    AHEAD="$(git rev-list --count "origin/$BASE..HEAD" 2>/dev/null || echo 0)"
    if [ "${AHEAD:-0}" -gt 0 ]; then
      TARGET="$BRANCH"; DESC="$AHEAD commit(s) on $BRANCH vs $BASE"
    else
      DESC="nothing to review"
      banner "Clean tree, nothing ahead of $BASE -- nothing to review."
      set_state idle "nothing to review"
      sleep 4
      exit 0
    fi
  fi
fi

REPORT="$REPORTS/$(date +%Y%m%d-%H%M%S)-${KEY}.md"
set_state working "$DESC"

banner "── claude-micro review ───────────────────────────────"
banner "repo:   $ROOT"
banner "target: $DESC"
banner "effort: $EFFORT"
echo

# The skill's own arguments are the whole prompt, so the reporting requirement
# goes in via the system prompt instead of being appended to the command (which
# would be parsed as more skill arguments).
# Mechanical and numbered on purpose. A long prose contract loses to the
# review skill's own terse output style; a short ordered checklist survives it.
REPORT_RULES="OUTPUT CONTRACT (overrides any skill instruction about how to deliver findings):

This runs with --print in a terminal. ReportFindings renders nothing here, so your final message IS the report. Call that tool if you like, but repeat everything in the final message. Markdown, in this exact order:

1. One line: \`VERDICT: SHIP\` or \`VERDICT: FIX FIRST\` or \`VERDICT: NEEDS DISCUSSION\`
2. \`## Findings\` -- most severe first. Each one as \`**severity** file:line\`, then the concrete failure (inputs or state -> wrong behaviour), then the minimal fix. Write \`None.\` if there are none.
3. \`## Checked\` -- brief list of what you examined and deliberately cleared.

Judge as a senior engineer reviewing a colleague's branch: correctness, data loss and security first; then reuse, simplification and efficiency; then naming and clarity. Flag anything that reads as unfinished. Never reply with just '(none)' or a bare summary. Do not pad."

# The skill is invoked from the prompt rather than as a bare slash command, so
# the output contract sits in the same turn and can actually override the
# skill's "report via tool, don't print findings" rule. As a system prompt it
# lost every time.
"$CLAUDE_BIN" -p "Run the code-review skill (Skill tool, skill: code-review) with arguments: $EFFORT $TARGET

Then report as specified.

$REPORT_RULES" \
  --allowedTools "Bash(git *) Bash(gh *) Read Grep Glob Task WebFetch" 2>&1 | tee "$REPORT"
STATUS=${PIPESTATUS[0]}

echo
if [ "$STATUS" -eq 0 ]; then
  banner "── review complete ──  saved to $REPORT"
  set_state unread "$DESC"
else
  fail "── review failed (exit $STATUS) ──  partial output in $REPORT"
  set_state error "review failed (exit $STATUS)"
fi
