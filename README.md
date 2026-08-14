# claude-micro

Turns a [Work Louder Codex Micro](https://worklouder.cc/) into a physical
control deck for [Claude Code](https://claude.com/claude-code) running in
tmux: keys jump between sessions and light up with each session's state, the
knob drives permission modes and the model picker, action keys answer
permission dialogs and fire canned workflows, and the joystick navigates
dialogs -- or, swirled all the way around, opens a hidden game.

## Requirements

- macOS, a Codex Micro, tmux, Node 18+, Claude Code
- ChatGPT.app installed -- the device SDK is extracted from it locally at
  install time (it is proprietary and not distributed here)

## Install

    git clone https://github.com/pidoshva/claude-micro.git
    cd claude-micro && ./install.sh

The installer copies everything into `~/.claude/micro`, installs the
companion skills (`/btw`, `/research`, `/ship`) into `~/.claude/skills`,
wires the Claude Code hooks (additive, backed up), builds the app bundle you
grant Input Monitoring to, and loads the LaunchAgent. Two manual steps remain
after it runs -- granting Input Monitoring and unassigning the daemon's keys
in the ChatGPT app -- and the installer prints both.

Per-machine settings live in `~/.claude/micro/config.json` (created from
`config.example.json`, never overwritten by reinstalls, hot-reloaded by the
daemon).

## The configurator: `claude-micro`

The installer puts `claude-micro` on your PATH — an interactive CLI for the
whole setup, no JSON editing required:

- **Keys** — assign any of the 13 keys: jump-to-pane, review, approve/deny,
  or any slash command / skill / custom prompt (it lists your installed
  skills). *Identify mode* asks you to press the physical key you mean.
- **Colors** — per-status color, effect, speed, brightness — every edit is
  **previewed live on the device's LEDs**, because tuning a color by hex code
  is not tuning a color.
- **Knob** — turn/click behavior, mode-cycle length, model-confirm scope.
- **Test** — fire any key's action from the CLI through the daemon's real
  dispatch path, and see the daemon log's verdict inline.

Everything saves straight to `config.json`, which the daemon hot-reloads —
there is no apply step. The CLI talks to the daemon over its localhost
control API (`/state`, `/next-press`, `/press`, `/preview`), so the daemon
remains the only process touching the device.

---

Turns the Codex Micro's first four agent keys into a **tmux switcher lit by
Claude Code session state**. Nothing here talks to Codex.

    AG00  tmux target 1     (this daemon)
    AG01  tmux target 2     (this daemon)
    AG02  tmux target 3     (this daemon)
    AG03  tmux target 4     (this daemon)
    AG04  review            (this daemon)
    AG05  standup prompt    (this daemon)

Every key is one entry in `config.json`, which is the schema the eventual setup
CLI will write:

    "keys": {
      "AG00": { "action": "tmux",   "index": 0 },
      "AG04": { "action": "review", "effort": "high" },
      "AG05": { "action": "none" }
    }

`index` selects which tmux target a key owns. `"none"` leaves the key to the
ChatGPT app. Changes are hot-reloaded — no restart. Adding an action means
adding one entry to the `ACTIONS` registry in `daemon.js`; nothing else in the
daemon needs to know about it.

Each key owns one tmux pane **by position, not by recency**, so a key always
means the same place. Order is session, then window, then top-to-bottom and
left-to-right — for a 2×2 grid that's top-left, top-right, bottom-left,
bottom-right. Press a key to jump there; its color shows the Claude Code
session running in that pane, or dim white if there isn't one. The pane you're
currently in shows at full brightness while the others are dimmed, so "where I
am" is readable at a glance.

## Status colors

Lifted from the ChatGPT app so the Claude keys match the Codex ones exactly:

| Status | Color | Meaning |
|---|---|---|
| `working` | blue `#304FFE` | turn in progress |
| `awaiting-approval` | orange `#FF6D00`, breathing | permission prompt / waiting on you |
| `unread` | green `#00FF4C` | turn finished, you haven't looked |
| `idle` | white `#FFFFFF` | attached, nothing pending |
| `error` | red `#FF0033` | reserved (not yet emitted) |
| `empty` | dim white | pane exists, no Claude session in it |
| — | off | no pane at that position |

Pressing a key switches your tmux client to that pane, raises the terminal
window in front of whatever you were looking at, and clears the pane's unread
light — so the pane is typed-into the moment the key is up. Navigation works
whether or not a Claude session lives there.

Which app to raise is worked out from the tmux client attached to that session:
walk up its process tree until a `.app` bundle turns up. Name one outright with
`focusApp` if the walk can't reach yours (a client behind ssh, say), or turn the
whole thing off with `"focusTerminal": false`.

### Double press to zoom

A second press of the same key within `doublePressMs` (600ms) zooms that pane to
the full window; the one after that puts it back. It's `tmux resize-pane -Z`, so
the daemon keeps no zoom state of its own and can't disagree with tmux about
what's zoomed. `"doublePress": "none"` turns it into an ordinary press.

Positions are read from `window_layout` rather than from `pane_top`/`pane_left`
**because** of this. A zoomed pane reports itself at `0,0` filling the window,
colliding with whatever really lives top-left, which reshuffled the positional
sort and quietly repointed the keys at different panes. `window_layout`
describes the layout ignoring zoom, so a key means the same pane zoomed or not.

### Whole-keyboard glow

The pane you're currently in also washes the **entire device** — key backlight
and ambient ring — in that session's status color, so the status you're sitting
in is readable without looking at any single key. `working` animates (snake),
everything else sits solid, matching the distinction the Codex app draws for a
selected thread. An active pane with no Claude session in it leaves the wash
off.

Tune with `glowBrightness` (default `0.4`), turn it off with `glow: false`, or
reserve it for states worth announcing:

    "glowStatuses": ["working", "awaiting-approval", "error"]

## The knobs

A knob acts on the pane you're in rather than owning one, so it pairs with the
keys: press a key to get somewhere, turn to change how the session there
behaves.

| Gesture | What it does | Sends |
|---|---|---|
| Turn | cycles permission modes — clockwise forward, anticlockwise back | `BTab` (`chat:cycleMode`) |
| Press | opens the model list | `M-p` (`chat:modelPicker`) |
| Turn, with the list up | moves through the models | `Up`/`Down` |
| Press again | applies the highlighted one to this session | `s` |

**Anticlockwise is a lap minus one step.** Shift+Tab only cycles forward and
Claude Code has no reverse action, so going back means going forward
`modeCycle - 1` times. That number has to be right or the direction is simply
wrong — with a 4-mode cycle, a `modeCycle` of 3 sends two taps and lands you
*forward* two instead of back one. Measured rather than assumed:

    manual -> accept edits -> plan -> auto -> manual

so `modeCycle` is `4`. Check yours by pressing Shift+Tab and reading the footer
round to where it started.

**A press confirms with `s`, not Enter.** The picker offers both: `Enter` sets
your default model for every session you start afterwards, `s` applies it to the
session in front of you. A knob that acts on the pane you're in shouldn't
silently rewrite a global setting — set `"confirm": "default"` if you want the
other one.

Nothing here touches the composer. An earlier version typed `/model`, which
meant emptying the prompt first — so a click part-way through writing a message
tried to delete it. The picker has its own binding; it gets asked for by key.

Whether the list is really up is checked against the rendered pane before either
gesture acts, not just remembered — you can close it with Esc and the daemon
can't see that. Acting on a stale belief is the expensive kind of wrong: turns
would walk your prompt history into the composer.

That check reads a marker off the pane, which means reading it **at that pane's
width**. The footer is one long line, and in a 66-column pane — the width the
keys exist to serve — it wraps between `Esc to` and `cancel`, so matching the
phrase as written found nothing and every turn fell through to cycling modes
while the list sat open. Newlines are flattened to spaces before matching. Any
marker taken off a TUI has this failure mode; test it at the narrow width, not
the one your test window happens to be.

One press of this encoder arrives as a **burst of eight notifications inside
100ms**, so clicks are debounced by `knobClickMs` (300ms). Without it a single
click opened the list and then confirmed it seven times over.

### Smoothing the rotation

The encoder reports a detent for the smallest movement, so raw it fires on a
brush past the knob. Two mechanisms, aimed at two different noises:

| Setting | Default | What it does |
|---|---|---|
| `turnWindowMs` | `80` | detents inside this window apply as a **net** figure, so a spurious step one way and one back cancel instead of becoming two actions |
| `turnSteps` | `2` | gearing: detents per action. `1` is one-for-one |
| `turnIdleMs` | `4000` | how long a leftover part-step waits for its partner before decaying |

At `turnSteps: 2` a nudge does nothing, a deliberate turn still works, and a
fast spin stays proportional — 8 detents become 4 moves. The remainder is kept
so slow turns add up, but not forever, or a stray detent from an hour ago would
pair with the next one you meant.

Both are hot-reloaded: turn `turnSteps` up if it's still twitchy, down to `1` if
it now feels sluggish, and the change takes effect on the next turn.

### Naming a knob

Encoder names aren't documented and vary by firmware, so they're config rather
than a guess. Turn a knob and the daemon reports what it saw, once:

    unknown control ENC_CW: {"k":"ENC_CW","act":2} -- name it in config.json
    under knobs.left.key or knobs.right.key

This firmware sends **one name per direction** and a third for the press, with
rotation carrying `act: 2` rather than a key-style press/release:

    ENC_CW   act 2    clockwise
    ENC_CC   act 2    anticlockwise
    ENC_CLK  act 1    press

which is wired as:

    "knobs": {
      "left":  { "key": "ENC_CLK", "cw": "ENC_CW", "ccw": "ENC_CC",
                 "turn": "mode", "click": "model" },
      "right": { "key": null, "turn": "none", "click": "none" }
    }

Rotation arrives one of two ways and both are read: a name per direction as
above, or a signed field on the notification (`d`, `dir`, `delta`, `step`,
`val`, `v`) — for that shape, set `key` alone and leave `cw`/`ccw` null.

`"debugReports": "raw"` logs every report the device sends, hex and decoded, for
working out a control that doesn't announce itself. RPC acks are filtered out of
that, or they'd bury everything else.

## The joystick: d-pad first, game second

The right joystick reports over its own channel (`v.oai.rad`, `{a, d}` — angle
as a fraction of a full turn, distance from center). Flicks are quantized to
the app's own quadrants (up / down / left / right), and what a flick *means*
depends on what's on screen in the focused session:

- **A dialog is up** (permission prompt, model picker, any selection menu):
  the stick is a d-pad — each flick lands as that arrow key. Jump to an orange
  key, flick down to the option you want, thumb the approve key.
- **No dialog**: flicks feed the game gesture. The game only opens after one
  **continuous swirl through all four directions** — the agent keys fill a
  quarter per direction visited — so menu navigation or knocking the stick can
  never trigger it. Letting the stick center (or stalling past `idleDropMs`)
  resets the gesture.

The game is **micro-drift**, same spirit as the Codex app's hidden one: an
arrow adrift in space, steered by the joystick, dodging asteroids that get
faster and more numerous. Touch one and the run ends: explosion, score, and
the window closes itself.

Mechanics:

- **The game is a tmux window**: the charge completing runs `game/drift.js` in
  a new window named `drift`, which opens focused in the session you're
  already in — no macOS window-raising rituals (the first Chrome version
  opened *behind* the terminal, and its player reasonably reported that
  nothing had opened). The process exiting closes the window, so a crash puts
  you right back where you were.
- The daemon still runs a localhost server (lazy, `gamePort`) that streams
  joystick positions over SSE; the game subscribes to it and POSTs `/gameover`
  on the way out. A window killed by hand is reaped when its SSE stream drops,
  so a dead game can't block the next charge.
- Terminal cells are ~2× taller than wide, so the game doubles vertical
  distances for collision and halves vertical motion to keep space square.
- While the game runs the agent row goes rainbow and the joystick belongs to
  the ship; crash (or `q`/Esc) and everything returns to session state. Arrow
  keys also steer.
- `joystick.display: "chrome"` brings back the browser version
  (`game/index.html`, Chrome `--app` window raised by pid).
- Config under `joystick`: `deadzone` (0.3), `chargeMs` (2000), `idleDropMs`
  (350), `gamePort` (4477), `display` (`tmux`).

## The action keys (ACT06–ACT12)

Below the agent row the device has seven action keys, `ACT06`–`ACT12`, with
swappable keycaps. They emit presses like the agent keys but have **no per-key
LED**, so their feedback is what happens in the pane (plus a log line). Assign
them in `keys` like any other key; unassigned ones are reported once on first
press so you can see their name.

Leave any key the daemon owns unassigned in the ChatGPT app's Codex Micro
settings, same rule as the agent keys — an app-side assignment would fire *in
addition to* the daemon's.

`ACT06` (the 7th key — the numbering continues from the agent row) is the
**research key**: it types `/research` into the focused session. The skill
(`~/.claude/skills/research/SKILL.md`) has the session frame a research brief
from its own context — the active topic, current architecture, constraints,
what's been ruled out — and launch a **Fable** agent to do the deep
architectural pass. The report comes back structured: problem, current
architecture, options each with pros/cons and migration cost, a plain
recommendation, ordered next steps, risks. Expect it to take minutes, not
seconds — it reads real code before theorizing. Typing `/research <topic>` by
hand overrides the inferred topic; the key always researches the active one.

`ACT07` / `ACT08` (keys 8 and 9) are **approve** and **deny**. Approve sends
**Enter** — accepting the dialog's *highlighted* option, which is "1. Yes"
untouched, or whatever the joystick was flicked to. Deny sends **Esc**, the
dialog's documented cancel. NOT `y`/`n`: the keybinding docs list those for
the Confirmation context, and testing against the real numbered permission
dialog showed they do nothing there — digits, Enter, and Esc are what it
speaks. Enter over `'1'` is deliberate: the joystick moves the highlight, so
approve means "confirm what I selected", not "always the first option".

The guard is the composer read inverted — a dialog must actually be on screen
(the unframed `❯` of a selection menu), or the press refuses rather than
sending a stray keystroke; that guard is also what makes Esc safe, since it
can never reach a running turn. Cooldown is short (`cooldownMs: 700`) because
permission prompts arrive back to back. The natural loop: a key breathes
orange, press it to jump there, flick the joystick to the option you want,
thumb 8 — all without the keyboard.

`ACT09` (key 10) is **ship**: it types `/ship`, a user-level skill
(`~/.claude/skills/ship/SKILL.md`) that opens a PR the way a human would.
It verifies the work sits on a clean, properly named branch — moving it off
main if that's where it is, committing stragglers in the repo's message
convention — pushes, and writes a concise PR: repo-convention title, a few
sentences of what/why/how-verified, **no AI attribution of any kind** (no
generated-with footer, no Co-Authored-By; the skill explicitly overrides
defaults that add them). Distinct from monolog's project `/pr` skill, which
stays template-driven.

### The `prompt` action

Types a canned prompt into the focused pane's Claude session and submits it —
the ask lives in config, so each key's wording is tunable without code:

    "AG05": { "action": "prompt", "label": "standup", "text": "Give me a structured status update..." }

`AG05` — the sixth agent key, which does have an LED — is the **standup key**:
it types `/btw` into the focused session. The `btw` skill
(`~/.claude/skills/btw/SKILL.md`) runs as a **fork**: a subagent inheriting
the session's full conversation writes the update (done / current issue /
remaining / risks, plus a three-sentence spoken-standup section) without
steering the session — and renders it in view as it completes. It reads the
whole conversation first, so give it a minute on a long session. The key sends one short command rather
than a wall of prompt text, so the transcript stays clean and the ask never
lands as a primary prompt steering the session. Sessions started before the
skill existed don't know `/btw` — restart those panes once.

Anything already typed in the composer is a draft the user means to keep — it's
**stashed** (`chat:stash`, one atomic C-s), the command is submitted, and a
second C-s brings the draft back. An earlier version deleted and retyped the
draft, which raced the user's own typing: press the key mid-sentence and the
verify loop kept seeing the keystrokes still being made, so the press "didn't
work" precisely when the user was busiest. Stash can't lose text — worst case
the draft sits in the stash and C-s recalls it by hand. If keystrokes are still
landing after the stash, the press steps aside with an error rather than
fighting for the keyboard, and pressing again after submitting works.

Pressing mid-turn is fine: Claude Code queues the message and answers it when
the current step completes. If a permission dialog is up, the press refuses
(same guard as the review key). Between typing a command and submitting it the
daemon waits a beat — a rapid burst ending in Enter can read as a paste, and a
submit swallowed into a paste is just a newline left sitting in the composer.

## The review key

`AG04` reviews whatever is worth reviewing, decided at press time. Exactly three
cases, in precedence order:

| Situation | What gets reviewed |
|---|---|
| Text typed in the focused pane's composer | that PR number, PR URL, or branch |
| Uncommitted changes in the repo | the working diff |
| Clean tree, branch ahead of base | its PR if one exists, else the branch |

A fourth outcome — clean tree with nothing ahead — is reported as "nothing to
review" rather than treated as an error.

The composer case is what makes the key work for remote branches: type `4821` or
a PR URL or a branch name into the Claude prompt, *don't* submit it, press the
key. Unsubmitted input can only be read off the rendered pane, so it's taken
from the single line after the `❯` marker.

**The review runs inside the session you're looking at.** The key types
`/code-review <effort> [target]` into that pane's composer and submits it. No
new panes, no new windows. Two reasons that beats spawning a headless run: the
session already knows its own repo and what it has been changing — better
context than anything inferable from the pane's cwd — and its findings render
natively in the TUI, where you can follow up with "fix the second one".

Because the work happens in the session, that **session's** key shows the
progress: blue while reviewing, green when it finishes. The review key itself
stays dim, and flashes red for a few seconds if it couldn't dispatch — no Claude
in the focused pane, or the session sitting on a permission prompt.

A second press within `actionCooldownMs` (2.5s) is ignored, so a double tap
can't queue two reviews.

### Reading the composer safely

Three traps, all handled:

- **Ghost text looks exactly like a draft.** Claude Code renders hints and
  unsent-message reminders *faint* (SGR 2) inside an empty composer. In a
  plain `capture-pane` that's indistinguishable from typed input: the daemon
  once spent a morning trying to delete text that didn't exist — C-u, forty
  backspaces, stash, all "failing" — and refusing every key press because the
  "draft" wouldn't die. The composer is therefore captured **with escape
  codes** (`-e`), and faint text after the `❯` reads as empty. Styling is the
  only reliable discriminator; the text itself can be anything, including an
  echo of the user's previous message.

- **A selection menu also draws `❯`.** A trust prompt renders
  `❯ 1. Yes, I trust this folder`, which would be read as a review target. The
  real composer is framed by box rules above and below; an unframed `❯` means a
  menu is up, and the action refuses rather than typing into a dialog.
- **Typed text has to be cleared**, or the command would be appended to it. The
  clear is `C-u`, verified by re-reading the composer, falling back to counted
  backspaces, and aborting if the line still isn't empty.

### Headless mode (opt-in)

`"AG04": { "action": "review", "mode": "headless" }` runs the review in a
detached `review` window via `claude -p` instead — useful when the focused pane
isn't a Claude session. It needs an output contract to produce anything
readable; see `bin/review.sh` and the note below.

### Getting a report out of a headless review

Only applies to `mode: "headless"`; in-session reviews render natively and need
none of this. Worth knowing if you touch `bin/review.sh`: the `code-review` skill delivers
findings through the `ReportFindings` tool, which renders nothing under
`--print`. The final message came back as literally `(none)`.

Fixing it took two goes. Putting the output contract in
`--append-system-prompt` lost every time — the skill's own "report via tool,
don't print findings" rule won. What works is invoking the skill *from the
prompt* (`Run the code-review skill ... with arguments: <effort> <target>`) so
the contract sits in the same turn and can override it, plus keeping that
contract mechanical and numbered rather than prose. The result is a report with
a `VERDICT:` line, findings ordered by severity with `file:line` and a concrete
failure scenario each, and a `Checked` section.

### Where a status comes from

Hook state is authoritative, but it only exists once a session has fired an
event. So the pane's process tree is checked too — a pane whose shell has a
`claude` child is a live session:

| Pane | Hook state | Shows |
|---|---|---|
| `claude` running | yes | the reported status |
| `claude` running | none yet | `idle` |
| no `claude` | either | `empty` (dim white) |

Which hooks write that state, and what each one means:

| Hook | Status |
|---|---|
| `SessionStart` | `idle` |
| `UserPromptSubmit` | `working` |
| `PermissionRequest` | `awaiting-approval` |
| `Elicitation` / `ElicitationResult` | `awaiting-approval` / `working` |
| `Notification` | depends on the message — see below |
| `PostToolUse` | `working` |
| `Stop` | `unread` |
| `SessionEnd` | removed |

**Notification is several events wearing one name**, and mapping them all to
orange painted finished sessions as "waiting on you": the idle *"Claude is
waiting for your input"* nag fires ~60s after a turn ends, long after there's
anything to approve — that was the stale orange. Now: a message mentioning
*permission* is unconditionally orange; the idle nag is orange only if the
session was `working` or already orange (meaning a question or dialog really
is holding a turn open); for a session that already finished, it changes
nothing. `PermissionRequest`/`Elicitation` report dialog state directly and
without guessing, but hook configs snapshot at session start — sessions
started before they were wired rely on the Notification heuristic alone.

`PostToolUse` is what takes a key back **off** orange, and it was missing.
Nothing fired between `Notification` and `Stop`, so answering a permission
prompt left the session recorded as `awaiting-approval` for the rest of the
turn — the key sat orange through minutes of work you'd already unblocked, and
the one status that means "go look at this" was the one you learned to ignore. A
completed tool call is the proof that nothing is waiting any more.

That last row matters: it means stale state is ignored rather than trusted, for
a session whose `claude` was killed without firing `SessionEnd`.

## How it works

The Micro is a Work Louder device (`303a:8360`) speaking JSON-RPC 2.0 over a
vendor HID interface (usage page `0xFF00`). Two channels are used, because each
one only works in one direction:

- **Writes** — `@worklouder/device-kit-oai`, the SDK that ships inside
  `ChatGPT.app`. `RPCApiOAI.sendThreadsLighting()` sets per-key color,
  brightness, effect and speed.
- **Reads** — a raw `node-hid` handle, parsed in `daemon.js`. The SDK's
  `onHidReceived()` never fires on this firmware: the device emits
  `{"m":"v.oai.hid","p":{"k":"AG02","act":1}}`, but the bundled dispatcher only
  matches JSON-RPC `{method, params}`. Report framing is
  `06 02 <len> <ascii json> 0d 0a`, zero-padded to 64 bytes.

Both handles open non-exclusive, so this coexists with the ChatGPT app.

### Two things that surprised me, and shape the design

1. **The app stomps one-shot writes.** It tracks an `appliedThreadLightingKey`
   and repaints all six keys whenever its own state changes — or whenever it
   reconnects, which a second process touching the device can itself trigger. A
   single write is invisible; the daemon re-asserts every `threadsReassertMs`
   (500ms), and that wins.
   This is also why the two Claude slots must be left **unassigned** in the
   app's Micro settings: unassigned keys are painted "off", so nothing contends
   for them. Keys the app thinks it owns will fight you.
2. **The device sleeps.** On wireless it drops off HID entirely when idle and
   reappears on the next keypress, so connect/paint failures are normal and the
   daemon just reconnects. When every slot is off it stops writing altogether
   rather than keeping the device awake for nothing.
3. **`tmux -F` output is environment-dependent.** With no usable locale — which
   is exactly how launchd runs things — tmux sanitizes control characters in
   format output, so a tab delimiter arrives as `_` and every line parses as a
   single field. Same format string, different bytes. Hence the printable
   `|;;|` delimiter, a forced `LANG`, and a parser that skips short lines
   instead of letting one bad line break the sort.

### Keeping the lights honest

The keys should be right the instant something changes, and the tick shouldn't
be what decides how late they are. Four things get in the way of that, all of
them fixed rather than tuned:

- **Redundant writes crowd out real ones.** An unchanged payload isn't sent;
  the same change-or-stale rule the glow uses now covers the keys too. Writing
  identical state four times a second kept the link busy for nothing, so a real
  change queued behind traffic saying what the device already knew.
- **A change during a write used to be dropped.** Only one RPC is in flight at a
  time, and a paint that arrived mid-write returned and waited for the next
  tick. It's remembered instead, and runs the moment the write finishes.
- **Nothing worth showing waits for the tick.** A hook writing `state.json`, a
  press, a zoom, a config reload — each repaints within `nudgeMs` (25ms). The
  tick is the fallback, not the schedule.
- **Cheap reads shouldn't run at the pace of expensive ones.** Where you are
  changes on every press; whether a pane has `claude` in it changes when you
  start or quit one. The pane list is re-read every tick (`panesTtlMs`), while
  the full `ps` scan runs on its own clock (`claudeScanMs`, 1.5s) off the paint
  path.

### Coming back after a drop

Wireless, the Micro drops off HID when it sleeps and reappears when you touch
it. Retries used to be a flat 2s poll from a fixed starting point, and a drop
could sit unlit far longer than that. Now the first retry after a drop is the
next tick, each failure doubles the wait to a 2s ceiling, and any success resets
it — so a wake is picked up immediately and a Micro left in a drawer is polled
twice a second at worst. A reconnect repaints in the same tick rather than the
one after, and a half-open attempt closes its handles before backing off, since
a leftover handle is what stops the next attempt from working.

## Files

| Path | Role |
|---|---|
| `daemon.js` | the service: reads state, paints LEDs, dispatches key actions |
| `bin/review.sh` | the review action: picks a target, runs it, writes the report |
| `actions/<KEY>.json` | action state, written by runners, drives that key's LED |
| `reports/` | saved review reports |
| `hook.py` | Claude Code hook; records session status + tmux pane |
| `config.json` | slots, colors, cadence, brightness (hot-reloaded) |
| `extract-sdk.js` | regenerates `lib/` from the installed ChatGPT.app |
| `patch-settings.py` | adds the hooks to `~/.claude/settings.json` (idempotent) |
| `install.sh` | all of the above + the LaunchAgent |
| `state.json` | runtime session state (written by `hook.py`) |
| `daemon.log` | what the daemon is doing |

`lib/` is generated, never vendored — it is extracted from the copy of
ChatGPT.app already on this machine.

## macOS Input Monitoring

Opening a HID keyboard interface requires **Input Monitoring**. A process
started by launchd holds no grant and cannot prompt for one, so it fails with
`cannot open device …` while the very same code run from a terminal works — the
terminal already has the grant and children inherit it. This is the one piece
that can't be automated:

    System Settings -> Privacy & Security -> Input Monitoring -> +
    add:  ~/.claude/micro/ClaudeMicro.app
    then: launchctl kickstart -k gui/$UID/com.vpid.claude-micro

`ClaudeMicro.app` exists only to be the thing you grant. Its executable is a
**hard link** to the `node` binary, so the grant is scoped to this daemon
instead of to every script `node` will ever run, and it survives nvm replacing
its own node. `make-app.sh` rebuilds it; re-granting is only needed if the
bundle is recreated from a different node.

## Operating it

    ~/.claude/micro/install.sh                          # install or repair
    tail -f ~/.claude/micro/daemon.log                  # watch it work
    launchctl bootout gui/$UID/com.vpid.claude-micro    # stop
    launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.vpid.claude-micro.plist

Re-run `install.sh` after a **ChatGPT.app update** (the SDK is re-extracted) or
a **Node upgrade** (the plist pins an absolute `node` path).

### Config

- `slots` — which agent keys to own, `[0, 1, 2, 3]`. Position in this array
  selects the tmux target, so `slots[0]` gets the first pane. Hot-reloaded;
  also update which keys you leave unassigned in the app.
- `target` — `"panes"` (default) or `"windows"`, if you'd rather the keys map to
  the first four tmux windows.
- `inactiveDim` / `highlightActive` — how much to dim keys that aren't the pane
  you're in. Set `highlightActive: false` for uniform brightness.
- `tmuxSocket` — normally left `null`; the socket is learned from the sessions
  themselves.
- `reassertMs` — repaint cadence, `250`. Raising it saves device battery but
  lets the app's repaints show through for longer.
- `brightness` — `0`–`1`.
- `focusApp` — app to bring forward on a press, e.g. `"Ghostty"`. `null` means
  work it out from the tmux client's process tree, which is usually right.
- `focusTerminal` — `false` leaves macOS window focus alone and only moves tmux.
- `pressDebounceMs` — chatter guard, `60`. Must stay well under `doublePressMs`,
  or the second press of a double is swallowed as a repeat.
- `doublePressMs` — how long a double press has to arrive in, `600`.
- `doublePress` — `"zoom"` or `"none"`.
- `knobs` — see [The knobs](#the-knobs). Per side: `key` / `cw` / `ccw` name the
  controls, `turn` is `"mode"` or `"none"`, `click` is `"model"` or `"none"`,
  `openKey` and `confirm` override the keys sent (`M-p`, `s`).
- `modeCycle` — how many permission modes a Shift+Tab lap has, `4`. Getting this
  wrong reverses nothing and skips instead.
- `pickerIdleMs` / `knobClickMs` — how long an untouched model list counts as
  still open (`15000`), and the click debounce (`300`).
- `panesTtlMs` / `claudeScanMs` — how often the pane list and the `ps` scan are
  re-read, `200` and `1500`.
- `threadsReassertMs` — how often unchanged key lighting is re-sent to beat the
  app's repaints, `500`. Changes are always sent immediately.
- `nudgeMs` — coalescing delay for an out-of-band repaint, `25`.
- `debugReports` — `true` logs decoded notifications, `"raw"` adds hex.
- `statusStyle` — per-status color (packed RGB int), `effect`
  (`off`/`solid`/`snake`/`rainbow`/`breath`/`gradient`/`shallowBreath`) and
  `speed` (`0`–`1`).

## Limits

- **A session that has never fired a hook shows `idle`, not its real state.**
  Process detection proves a session is *there*, not what it's doing; the real
  status arrives with its next prompt or turn end.
- **Only one daemon may run.** A second instance fights the first for the same
  RPC channel, which surfaces as write failures and doubled key presses rather
  than as anything obviously wrong. A pidfile guard enforces it; stop the
  running one via `kill $(cat ~/.claude/micro/daemon.pid)`.
- **Pane order shifts if you restructure the window.** Positions are recomputed
  from tmux geometry every second, so splitting or closing panes reshuffles
  which key points where.
- **`error` is never emitted.** Claude Code has no hook that cleanly signals a
  failed turn; the color is wired up and waiting for one.
- **`unread` clears on a key press, not when you actually read the pane.**
  Reading a session by switching to it any other way leaves the light on until
  the next hook event.
- **Presses are only read while the daemon is connected.** If the device is
  asleep, the first press wakes it and is consumed by the wake — press again.
- **`hook.py` records `TMUX_PANE` per session.** A Claude session not running
  under tmux gets a light but a press can't focus it.
