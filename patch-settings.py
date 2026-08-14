#!/usr/bin/env python3
"""
Adds the claude-micro hooks to ~/.claude/settings.json.

Idempotent and additive: existing hook entries (including the agent-factory
ones) are left exactly as they are, and re-running this makes no further
changes. A timestamped backup is written before the first modification.
"""
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SETTINGS = os.path.expanduser('~/.claude/settings.json')
HOOK = os.path.join(HERE, 'hook.py')
PY = '/usr/bin/python3'
EVENTS = [
    'SessionStart', 'UserPromptSubmit', 'Notification', 'PermissionRequest',
    'Elicitation', 'ElicitationResult', 'PostToolUse', 'Stop', 'SessionEnd',
]


def main():
    if not os.path.exists(SETTINGS):
        settings = {}
    else:
        with open(SETTINGS) as fh:
            settings = json.load(fh)

    hooks = settings.setdefault('hooks', {})
    added = []

    for event in EVENTS:
        command = f'{PY} {HOOK} {event}'
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            print(f'!! hooks.{event} is not a list; skipping', file=sys.stderr)
            continue
        already = any(
            HOOK in (h.get('command') or '')
            for g in groups if isinstance(g, dict)
            for h in (g.get('hooks') or []) if isinstance(h, dict)
        )
        if already:
            continue
        groups.append({'hooks': [{'type': 'command', 'command': command}]})
        added.append(event)

    if not added:
        print('hooks already present; nothing to change')
        return

    if os.path.exists(SETTINGS):
        backup = f'{SETTINGS}.bak-claude-micro-{time.strftime("%Y%m%d-%H%M%S")}'
        shutil.copy2(SETTINGS, backup)
        print(f'backed up settings -> {backup}')

    tmp = SETTINGS + '.tmp'
    with open(tmp, 'w') as out:
        json.dump(settings, out, indent=2)
        out.write('\n')
    os.replace(tmp, SETTINGS)
    print('added hooks for: ' + ', '.join(added))


if __name__ == '__main__':
    main()
