#!/usr/bin/env python3
"""
Claude Code hook -> claude-micro session state.

Wired into ~/.claude/settings.json for a handful of events; each invocation
records one session's current status and bumps its recency, which is how the
daemon decides which two sessions own the LEDs.

Status vocabulary mirrors the Codex Micro's own, so the Claude keys read the
same way as the Codex ones:

    SessionStart      -> idle
    UserPromptSubmit  -> working
    PermissionRequest -> awaiting-approval   (a dialog is up)
    Elicitation       -> awaiting-approval   (AskUserQuestion is up)
    ElicitationResult -> working             (it was answered)
    Notification      -> depends on the message; see notification_status()
    PostToolUse       -> working             (a tool ran, so nothing is waiting)
    Stop              -> unread              (turn finished, you haven't looked)
    SessionEnd        -> removed

PostToolUse is what takes the key back off orange. Nothing else fires between
a permission ask and Stop, so answering a prompt once left the session
recorded as awaiting-approval for the rest of the turn -- the light said "waiting
on you" through minutes of work you'd already unblocked. A completed tool call
is the proof that it isn't waiting any more.

This must never break the session it's attached to: every failure path exits 0.
"""
import fcntl
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, 'state.json')
LOCK = STATE + '.lock'
STALE_SECONDS = 12 * 3600

STATUS_BY_EVENT = {
    'SessionStart': 'idle',
    'UserPromptSubmit': 'working',
    'PermissionRequest': 'awaiting-approval',
    'Elicitation': 'awaiting-approval',       # AskUserQuestion mid-turn
    'ElicitationResult': 'working',
    'PostToolUse': 'working',
    'Stop': 'unread',
    'SubagentStop': 'working',
}

KEEP_CURRENT = 'keep'


def notification_status(payload, prior):
    """Notification is several different events wearing one name, and mapping
    them all to awaiting-approval painted finished sessions orange: the idle
    "waiting for your input" nag fires ~60s after a turn ends, long after
    there is anything to approve. Only a permission ask is unconditionally
    orange. The idle nag is orange only when it means a session is actually
    stuck mid-turn on something (working -> a question or dialog is up);
    for a session that already finished, it changes nothing."""
    message = str(payload.get('message', '')).lower()
    if 'permission' in message:
        return 'awaiting-approval'
    if prior in ('working', 'awaiting-approval'):
        return 'awaiting-approval'
    return KEEP_CURRENT


def load(fh):
    try:
        fh.seek(0)
        data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get('sessions'), dict):
            return data
    except Exception:
        pass
    return {'sessions': {}}


def main():
    raw = sys.stdin.read() if not sys.stdin.isatty() else ''
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}

    event = sys.argv[1] if len(sys.argv) > 1 else payload.get('hook_event_name', '')
    session_id = payload.get('session_id') or os.environ.get('CLAUDE_SESSION_ID')
    if not event or not session_id:
        return

    now = time.time() * 1000

    os.makedirs(HERE, exist_ok=True)
    with open(LOCK, 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            try:
                fh = open(STATE, 'r+')
            except FileNotFoundError:
                fh = open(STATE, 'w+')
            with fh:
                state = load(fh)
                sessions = state['sessions']

                if event == 'SessionEnd':
                    sessions.pop(session_id, None)
                else:
                    entry = sessions.get(session_id, {})
                    if event == 'Notification':
                        status = notification_status(payload, entry.get('status'))
                        if status == KEEP_CURRENT:
                            status = entry.get('status') or 'idle'
                    else:
                        status = STATUS_BY_EVENT.get(event)
                    if status is None:
                        return
                    cwd = payload.get('cwd') or entry.get('cwd') or os.getcwd()
                    entry.update({
                        'status': status,
                        'updated': now,
                        'cwd': cwd,
                        'title': os.path.basename(cwd.rstrip('/')) or cwd,
                        # Re-read each time: the session can be moved to another
                        # pane, or reattached to a different tmux server.
                        'pane': os.environ.get('TMUX_PANE') or entry.get('pane'),
                        'tmux': os.environ.get('TMUX') or entry.get('tmux'),
                    })
                    entry.setdefault('started', now)
                    sessions[session_id] = entry

                cutoff = now - STALE_SECONDS * 1000
                state['sessions'] = {
                    sid: s for sid, s in sessions.items()
                    if isinstance(s, dict) and (s.get('updated') or 0) > cutoff
                }

                tmp = STATE + '.tmp'
                with open(tmp, 'w') as out:
                    json.dump(state, out)
                os.replace(tmp, STATE)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass  # never interfere with the Claude Code session
    sys.exit(0)
