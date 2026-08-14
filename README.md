<div align="center">

# claude-micro

**Turn a [Work Louder Codex Micro](https://worklouder.cc/) into a physical control deck for [Claude Code](https://claude.com/claude-code).**

Keys jump between tmux sessions and glow with each session's live state.
The knob drives permission modes and the model picker. Action keys answer
permission dialogs and fire your workflows. The joystick navigates menus —
or, swirled all the way around, opens a hidden game.

```
        ╭─────────────────────────────────────────────╮
        │    ①   ②   ③   ④   ⑤   ⑥     ← agent row    │
        │   ▁▁  ▁▁  ▁▁  ▁▁  ▁▁  ▁▁       (RGB per key) │
        │                                             │
        │    ⑦   ⑧   ⑨   ⑩   ⑪   ⑫   ⑬  ← action row   │
        │                                             │
        │    ◉ knob                joystick ✛         │
        ╰─────────────────────────────────────────────╯
                   (schematic, not to scale)
```

`macOS` · `Node ≥ 18` · `tmux` · `zero runtime dependencies`

</div>

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [The controls](#the-controls) — [agent keys](#agent-keys-16-jump-zoom-glow) · [action keys](#action-keys-713) · [the knob](#the-knob) · [the joystick & game](#the-joystick--the-game)
- [Status lights](#status-lights)
- [The configurator: `claude-micro`](#the-configurator-claude-micro)
- [Guide: wiring skills and actions](#guide-wiring-skills-and-actions)
- [Guide: connecting your tmux setup](#guide-connecting-your-tmux-setup)
- [Companion skills](#companion-skills)
- [How it works](#how-it-works)
- [Field notes](#field-notes) — the hard-won gotchas
- [Configuration reference](#configuration-reference)
- [Limits](#limits)

## What it does

You run several Claude Code sessions in tmux panes. This makes the Micro
their mission control:

| Control | Out of the box |
|---|---|
| **1 – 4** | jump to a tmux pane · double-press zooms it full-window |
| **5** | `/code-review` the focused session (typed text becomes the target) |
| **6** | `/btw` — structured standup update from the focused session |
| **7** | `/research` — deep architectural dive on the session's active topic |
| **8** | **approve** the visible permission dialog |
| **9** | **deny** it |
| **10** | `/ship` — commit, push, open a concise PR |
| **11 – 13** | yours to assign |
| **knob turn** | cycle permission modes, both directions |
| **knob click** | model picker: click to open, turn to choose, click to apply |
| **joystick** | d-pad in dialogs · full swirl opens [the game](#the-joystick--the-game) |

Every key is reassignable — see [the configurator](#the-configurator-claude-micro).
The lights tell you who needs you: a key **breathing orange** is a session
waiting on a permission prompt; **green** finished while you were elsewhere;
**blue** is working. Press it, read, flick the joystick to an option, thumb
approve — without touching the keyboard.

## Quick start

**Requirements:** macOS · a Codex Micro · tmux · Node 18+ · Claude Code ·
ChatGPT.app installed (the device SDK is extracted from it locally — it is
proprietary and never ships in this repo).

```bash
git clone https://github.com/pidoshva/claude-micro.git
cd claude-micro && ./install.sh
```

The installer copies everything into `~/.claude/micro`, installs the
[companion skills](#companion-skills) into `~/.claude/skills`, wires the
Claude Code hooks (additive, backed up first), builds the app bundle you
grant Input Monitoring to, puts `claude-micro` on your PATH, and loads the
LaunchAgent. Per-machine settings live in `~/.claude/micro/config.json` —
created once, never overwritten by reinstalls, hot-reloaded by the daemon.

**Two manual steps remain** — macOS will not let a script do them:

1. **Grant Input Monitoring**: System Settings → Privacy & Security →
   Input Monitoring → add `~/.claude/micro/ClaudeMicro.app`, then
   `launchctl kickstart -k gui/$UID/com.claude-micro`.

   <details><summary>Why an app bundle?</summary>

   Opening a HID keyboard interface requires Input Monitoring. A launchd
   process holds no grant and cannot prompt for one — the same code works
   from a terminal only because the terminal already has the grant and
   children inherit it. `ClaudeMicro.app` exists to be *the thing you
   grant*: its executable is a hard link to your `node` binary, scoping the
   grant to this daemon instead of to every script node will ever run.
   `make-app.sh` rebuilds it; re-granting is only needed if it's rebuilt
   from a different node.
   </details>

2. **In the ChatGPT app**: Settings → Codex Micro → leave every key the
   daemon owns **unassigned**. The app repaints keys it thinks it owns and
   will fight the daemon for them; unassigned keys are painted off and left
   alone.

Then run `claude-micro` and make the board yours.

## The controls

### Agent keys 1–6: jump, zoom, glow

Press a key → your tmux client switches to that pane, the terminal window is
raised in front of whatever you were looking at, and the pane's unread light
clears. The pane is typed-into the moment the key is up.

- **Double-press** (within 600ms) zooms the pane full-window; again restores.
  It's `tmux resize-pane -Z`, so the daemon holds no zoom state and can't
  disagree with tmux about what's zoomed.
- Which terminal app to raise is discovered by walking the tmux client's
  process tree to the nearest `.app` bundle. Set `focusApp` if the walk
  can't reach yours (a client behind ssh), or `focusTerminal: false` to
  leave macOS focus alone.
- The pane you're in shows full-brightness while the others dim — "where am
  I" at a glance. The **whole device** (key backlight + ambient ring) also
  washes in the focused session's status color; `working` animates, the rest
  sit solid. Tune with `glowBrightness`, restrict with `glowStatuses`, or
  disable with `glow: false`.

### Action keys 7–13

No per-key LEDs — their feedback is what happens in the pane, plus a log
line. Each can carry any [action type](#the-action-types); unassigned keys
report their name on first press so you can find them.

The two special ones ship on 8 and 9:

- **Approve** sends **Enter** — accepting the dialog's *highlighted* option:
  "1. Yes" untouched, or whatever the joystick was flicked to.
- **Deny** sends **Esc** — the dialog's documented cancel.

Both refuse unless a dialog is actually on screen, so they can never type
stray characters into a message or interrupt a running turn. Their cooldown
is short (700ms) because permission prompts arrive in trains.

### The knob

The knob acts on the pane you're in — press a key to get somewhere, turn to
change how the session there behaves.

| Gesture | Effect | Sends |
|---|---|---|
| Turn | cycle permission modes, both directions | `BTab` |
| Press | open the model picker | `M-p` |
| Turn, list open | move through models | `Up` / `Down` |
| Press again | apply to **this session** | `s` |

<details><summary>Why anticlockwise is "a lap minus one", and why apply is <code>s</code></summary>

Shift+Tab only cycles forward and Claude Code has no reverse binding, so
going back means going forward `modeCycle − 1` times. That number must match
your build — measure it by pressing Shift+Tab round to where you started
(default `4`: manual → accept edits → plan → auto). Get it wrong and "back"
skips instead of reversing.

The model picker offers two confirms: `Enter` sets your **global default
model** for every future session; `s` applies to the session in front of
you. A knob acting on the pane you're in shouldn't silently rewrite a global
setting — set `"confirm": "default"` for the other behavior.
</details>

<details><summary>Encoder facts: names, click bursts, rotation smoothing</summary>

This firmware reports rotation as one name per direction (`ENC_CW` /
`ENC_CC`, `act: 2`) and the click as `ENC_CLK`. Unrecognized controls are
logged once with their full payload — that line is what you paste into
`knobs.left` in the config. One physical **click arrives as a burst of ~8
notifications inside 100ms**, so clicks are debounced (`knobClickMs`, 300ms).

Rotation smoothing: `turnWindowMs` (80) applies detents as a net figure so
jitter cancels instead of becoming two actions; `turnSteps` gears
detents-per-action — on this hardware one physical click emits exactly one
event, so `1` is right and higher gearing makes it *skip*; `turnIdleMs`
decays a leftover part-step so a stray detent can't ambush a later turn.
</details>

### The joystick — the game

Flicks are quantized to quadrants (up / down / left / right), and what a
flick *means* depends on what's on screen in the focused session:

- **A dialog is up** (permission prompt, model picker, any selection menu):
  the stick is a **d-pad** — each flick lands as that arrow key.
- **No dialog**: flicks feed the game gesture. One **continuous swirl
  through all four directions** — the agent keys fill a quarter per
  direction visited — opens **micro-drift** in a new tmux window: an arrow
  adrift in space, steered by the joystick, dodging asteroids that get
  faster and more numerous. Collide and the run ends — explosion, score, the
  window closes itself, and tmux drops you back where you were. Arrow keys
  also steer; `q`/Esc quits.

The all-four-directions swirl is the validation gesture: menu flicks or
knocking the stick can hit one or two quadrants, never all four in one
motion — the game can't open uninvited.

<details><summary>Game internals</summary>

The daemon serves the game over localhost and streams joystick positions to
it via SSE (`{a, d}`: angle as a fraction of a full turn, distance from
center — the `v.oai.rad` channel, the device SDK's own convention). The
terminal edition (`game/drift.js`) uses **diffed rendering** — only changed
cells are written, a frame is a few hundred bytes, ~1000× less terminal
traffic than repainting — at 60fps with a backpressure guard so a slow
terminal skips frames instead of accumulating lag. Terminal cells are ~2×
taller than wide; collision and motion compensate so space feels square.
While a game runs the daemon goes **radio-quiet** (see
[field notes](#field-notes)). `joystick.display: "chrome"` swaps in the
browser edition (`game/index.html`), a Chrome `--app` window the daemon
raises by pid and closes on game over.
</details>

## Status lights

Colors are lifted from the ChatGPT app so the Claude keys read like Codex
ones — and every one is customizable with a live preview on the hardware:

| Status | Default | Meaning |
|---|---|---|
| `working` | 🔵 blue `#304FFE` | turn in progress |
| `awaiting-approval` | 🟠 orange `#FF6D00`, breathing | dialog / question waiting on you |
| `unread` | 🟢 green `#00FF4C` | turn finished, you haven't looked |
| `idle` | ⚪ white | attached, nothing pending |
| `error` | 🔴 red `#FF0033` | an action key press failed (brief flash) |
| `empty` | dim white | pane exists, no Claude session in it |
| — | off | no pane at that position |

<details><summary>Where a status comes from (hooks reference)</summary>

`hook.py` is wired into Claude Code's hooks and writes `state.json`; the
daemon only reads it. A pane whose process tree has no `claude` shows
`empty` regardless of stale state — a killed session can't leave a lying
light.

| Hook | Status |
|---|---|
| `SessionStart` | `idle` |
| `UserPromptSubmit` | `working` |
| `PermissionRequest` | `awaiting-approval` |
| `Elicitation` / `ElicitationResult` | `awaiting-approval` / `working` |
| `Notification` | depends on the message — see below |
| `PostToolUse` | `working` — what takes a key back **off** orange |
| `Stop` | `unread` |
| `SessionEnd` | removed |

**Notification is several events wearing one name.** A message mentioning
*permission* is unconditionally orange. The idle *"waiting for your input"*
nag — which fires ~60s after a turn ends — is orange only if the session was
`working` or already orange (a question or dialog genuinely holding a turn
open); for a finished session it changes nothing. Mapping every Notification
to orange is how you get stale orange keys on idle sessions.
</details>

## The configurator: `claude-micro`

The installer puts `claude-micro` on your PATH. The main screen is a **live
mirror of the device** — each agent key drawn in its actual LED color,
refreshing in place as sessions change state:

```
claude-micro configurator   daemon up · device connected
────────────────────────────────────────────────────────────────────────
   ██ ██ ██ ██ ██ ██    ◉ knob   ✛ joystick
   1  2  3  4  5  6
   7·research  8·approve  9·deny  10·ship  11·  12·  13·
  ❯ Keys    assign actions to the 13 keys
    Tmux    connect keys to your panes, windows, socket
    Knob    turn & click behavior
    Colors  status colors, previewed live on the device
    Test    fire any key's action from here
    Quit
```

- **Keys** — assign anything to any key. *Identify mode*: press the physical
  key you mean; the press is swallowed, never fired.
- **Tmux** — the live pane map and both pane-addressing modes
  ([guide](#guide-connecting-your-tmux-setup)).
- **Colors** — a preset palette or free hex (`#RRGGBB` / `#RGB` / `0x…`)
  with a **live swatch as you type**; every edit previews on the physical
  LEDs and mirrors the effect (breath, snake, rainbow) as a terminal
  animation. Ctrl+U clears a prefilled field.
- **Test** — fire any key through the daemon's *real* dispatch path and see
  the daemon log's verdict inline. Guards included: testing approve with no
  dialog up shows you the refusal, exactly as a physical press would.

Everything saves straight to `config.json`, which the daemon hot-reloads —
no apply step. The CLI talks to the daemon over its localhost control API
(`/state`, `/next-press`, `/press`, `/preview`), so the daemon remains the
only process touching the device.

## Guide: wiring skills and actions

Three ways to wire a key, in order of comfort:

1. **`claude-micro` → Keys** — pick the key from the list.
2. **Identify mode** — "⊙ identify", press the physical key, land in its
   editor.
3. **`config.json` directly** — one entry per key; hot-reloaded on save.

### The action types

| Action | Config | A press… |
|---|---|---|
| `tmux` | `{ "action": "tmux", "index": 0 }` or `{ …, "target": "work:2.1" }` | jumps there (double-press zooms) |
| `prompt` | `{ "action": "prompt", "label": "standup", "text": "/btw" }` | types into the focused session and submits |
| `review` | `{ "action": "review", "effort": "high" }` | `/code-review`; typed composer text becomes the target |
| `approve` | `{ "action": "approve", "cooldownMs": 700 }` | Enter on the visible dialog — refuses if none |
| `deny` | `{ "action": "deny", "cooldownMs": 700 }` | Esc on the visible dialog — same guard |
| `command` | `{ "action": "command", "run": "…" }` | runs a shell command — [below](#custom-actions-your-own-commands-and-keystrokes) |
| `keys` | `{ "action": "keys", "keys": ["C-o"] }` | sends raw keystrokes to the focused pane |
| `none` | `{ "action": "none" }` | leaves the key to the ChatGPT app |

The `prompt` action never destroys typing: an in-progress draft is
**stashed** (`C-s`), the command submits, the draft is restored. If you're
actively typing at press-time it politely refuses instead of fighting your
keyboard.

### Custom actions: your own commands and keystrokes

**`command`** — any shell command, with press context as environment:

```json
{ "action": "command", "label": "deploy", "run": "~/bin/deploy.sh staging", "window": true }
```

`window: true` opens a focused tmux window (interactive things, things you
want to watch); without it the command runs detached — outcome logged, red
key-flash on failure.

| Variable | Value |
|---|---|
| `MICRO_KEY` | the key that fired (`ACT10`) |
| `MICRO_PANE` | active tmux pane id (`%3`) |
| `MICRO_PANE_PATH` | that pane's working directory |
| `MICRO_SESSION` | that pane's tmux session name |

**`keys`** — raw keystrokes in tmux `send-keys` syntax, for wiring device
keys to any binding the pane's program understands — Claude Code's `C-o`
(transcript), `M-t` (thinking toggle), or whatever your vim answers to:

```json
{ "action": "keys", "label": "transcript", "keys": ["C-o"] }
```

**The action library** — define once in `~/.claude/micro/actions.json`,
reuse on any key with a reference:

```json
// actions.json
{ "deploy-staging": { "action": "command", "run": "~/bin/deploy.sh staging",
                      "window": true, "description": "deploy current repo" } }

// config.json, any key:
"ACT10": { "use": "deploy-staging" }
```

Library entries appear in the CLI's key editor marked ⚡; editing the
library propagates to every key referencing it; fields set directly on a key
override the library's; both files hot-reload. After building a custom
action in the CLI you're offered "save to the library" — that's how entries
get created without touching JSON. A dangling `use` shows red in the CLI
instead of failing silently. An install ships two `__example-*` entries to
copy from.

### Where skills live

A **skill** is a folder with a `SKILL.md` — the instructions a slash command
carries. Two places matter:

- **`~/.claude/skills/<name>/SKILL.md`** — user-level: every project, and
  **what the CLI's picker lists**. This repo's skills install here.
- **`<repo>/.claude/skills/<name>/SKILL.md`** — project-level: sessions in
  that repo only. A button can still type it (Custom text → `/that-skill`);
  it won't be in the picker.

Minimal button-friendly skill:

```markdown
---
name: standup-brief
description: |
  One-paragraph status of this session's current work.
user-invocable: true
disable-model-invocation: true
---

Report in one tight paragraph what this session is working on,
what just changed, and what happens next. Take no actions.
```

Drop it in, run `claude-micro`, assign it — the picker finds it immediately.
Worth knowing: a button types into the **focused pane's** session, so one
key works across every project, each session answering from its own
context; and sessions discover skills at start — a session older than the
skill needs a restart to know the command.

## Guide: connecting your tmux setup

Keys find panes **two ways**, because setups disagree about what "the same
place" means:

| Mode | Config | Behaves like |
|---|---|---|
| **By position** | `{ "action": "tmux", "index": 0 }` | "the top-left pane, whatever lives there" — panes sorted session → window → top → left. Survives pane churn. |
| **Pinned** | `{ "action": "tmux", "target": "work:2.1" }` | "THAT pane, wherever it moves" — exact `session:window.pane`. Survives reshuffles; the key goes dark if the pane doesn't exist. |

The CLI's **Tmux** screen shows your live panes in key order — ● marks panes
running Claude, plus your current position — and both assignment flows pick
from that list rather than asking you to imagine sorted indices:

```
Tmux — live panes in key order:
  #1 powersesh:1.1          claude ●
  #2 powersesh:1.2          node
  #3 powersesh:1.3          claude ●
  #4 powersesh:1.4          claude ●  ← you
  #5 powersesh:2.1          node
  ❯ Target mode: panes   panes = individual panes · windows = whole windows
    Socket: auto          set for a custom -S socket
    Reassign keys 1-6 to panes…
```

Also there: **target mode `windows`** — keys map to whole tmux windows, for
one-window-per-project setups — and custom **socket** paths (normally
learned from the running sessions). Multi-session layouts just work: the
sort spans sessions, and pinning is the natural fit when your layout does
too.

## Companion skills

Installed to `~/.claude/skills`, wired to keys 6, 7, 10 by default — and
just as useful typed by hand:

| Skill | What it does |
|---|---|
| **/btw** | Structured status — done / current / remaining / risks — plus a 3-sentence plain-language standup anyone in the room understands. Answered inline by the session: full context, one line of transcript noise. |
| **/research** | The session frames a research brief from its own context, then delegates the deep architectural pass to a **Fable** agent: options with pros/cons and migration costs, a plain recommendation with its flip conditions, ordered next steps, risks. |
| **/ship** | Verifies the work sits on a clean, properly named branch (moving it off main if that's where it is), commits stragglers in the repo's own convention, pushes, and opens a **concise, human-written PR** — no AI attribution anywhere, explicitly. |

## How it works

```
 Codex Micro ──HID──▶ daemon.js ◀──hooks── Claude Code sessions
      ▲                  │ ▲                  (hook.py → state.json)
      │ lighting RPCs    │ │ localhost API
      ╰──────────────────╯ ▼
                  claude-micro CLI · micro-drift game
```

- **Writes** go through `@worklouder/device-kit-oai` — the SDK inside
  ChatGPT.app, extracted locally by `extract-sdk.js`, never vendored.
- **Reads** are a raw `node-hid` handle: the firmware emits
  `{"m":"v.oai.hid","p":{"k":"AG02","act":1}}` notifications the bundled
  dispatcher doesn't match, so the daemon parses reports itself. Both
  handles open non-exclusive, coexisting with the ChatGPT app.
- **Session state** flows from Claude Code hooks (`hook.py`) into
  `state.json`; the daemon watches the file, so a finishing turn repaints in
  ~25ms instead of on the next poll. Unchanged lighting is never re-sent
  except to beat the app's repaints.
- The **control API** (`127.0.0.1:<gamePort>`) serves the CLI and the game:
  state, press-identify, synthesized presses, lighting previews, SSE.

## Field notes

The gotchas that shaped the design. Each cost a real debugging session, so
they're written down where the next person can find them.

<details><summary><b>The ChatGPT app stomps one-shot lighting writes</b></summary>

The app repaints all six keys whenever its own state changes — or whenever
it reconnects, which a second process touching the device can itself
trigger. A single write is invisible. The daemon re-asserts unchanged
lighting every `threadsReassertMs` (500ms), sends changes immediately, and
otherwise never repeats an identical payload — identical writes four times a
second kept the link busy enough that real changes queued behind traffic
saying nothing. This is also why keys the daemon owns must be **unassigned**
in the app.
</details>

<details><summary><b>Bluetooth: pretty lights tax the joystick</b></summary>

On BLE, every lighting RPC competes with input notifications for connection
airtime — the game's controls were laggy *because the rainbow was pretty*.
While a game runs the daemon goes radio-quiet: the rainbow goes out once and
nothing re-asserts until the game ends. Nagle's algorithm also buffered the
~30-byte SSE joystick frames — exactly what it exists to coalesce — so the
stream sets `TCP_NODELAY`.
</details>

<details><summary><b>Ghost text: the composer lies to plain capture</b></summary>

Claude Code renders hints — including an echo of your previous message —
*faint* (SGR 2) inside an **empty** composer. In a plain `capture-pane`
that's byte-identical to a typed draft: the daemon once spent a morning
sending C-u, forty backspaces, and a stash at text that didn't exist,
refusing every key press because the "draft" wouldn't die. The composer is
read **with escape codes** (`-e`), and faint text after the `❯` counts as
empty. Styling is the only reliable discriminator.
</details>

<details><summary><b>Reading the composer safely: two more traps</b></summary>

A selection menu also draws `❯` — a trust prompt renders `❯ 1. Yes, I trust
this folder`, which must never be read as typed input nor typed into. The
real composer is framed by box rules; an unframed `❯` means a dialog is up —
and that same signal, inverted, is the approve/deny guard. Separately: any
marker read off a TUI must be tested **at the pane's real width** — the
model picker's footer wraps mid-phrase at 66 columns, which once broke
picker detection in exactly the panes the keys exist to serve. Captured text
is flattened before matching.
</details>

<details><summary><b>The permission dialog does not speak y/n</b></summary>

The documented Confirmation bindings say `y`/`n`; tested against the real
numbered permission dialog, they do nothing. **Digits** pick options
directly, **Enter** accepts the highlighted option, **Esc** cancels. Approve
sends Enter rather than `1` deliberately — the joystick moves the highlight,
so approve means "confirm what I selected", not "always the first option".
</details>

<details><summary><b>tmux -F output is environment-dependent</b></summary>

With no usable locale — exactly how launchd runs things — tmux sanitizes
control characters in format output: a tab delimiter arrives as `_` and
every line parses as one field. Hence a printable `|;;|` delimiter, a forced
`LANG`, and a parser that skips short lines. Relatedly, pane positions come
from `window_layout`, not `pane_top`/`pane_left`: a zoomed pane reports
itself at 0,0 filling the window, which reshuffled the positional sort and
silently repointed keys at different panes.
</details>

<details><summary><b>Wireless reconnect: fast when it matters</b></summary>

The Micro drops off HID when it sleeps and reappears when touched. Retries
back off exponentially from *immediate* to a 2s ceiling — a wake is caught
on the next tick, a Micro in a drawer is polled twice a second at worst —
and a reconnect repaints in the same tick rather than the one after.
Half-open connection attempts close their handles before retrying, since a
leftover handle is what blocks the next attempt.
</details>

<details><summary><b>The review key's composer trick, and headless mode</b></summary>

Type a PR number, URL, or branch into the composer — don't submit — and
press review: the typed text becomes the review target. The review runs
*inside* the session you're looking at (better context than anything
inferable from a cwd, findings render natively). `"mode": "headless"`
instead runs `claude -p` in a detached window — it needs an explicit output
contract (see `bin/review.sh`) because the code-review skill's findings tool
renders nothing under `--print`.
</details>

## Configuration reference

`~/.claude/micro/config.json`, hot-reloaded on save. The configurator edits
all of the common ones; this is the full list.

<details><summary><b>All settings</b></summary>

| Key | Default | Meaning |
|---|---|---|
| `keys` | — | one entry per key; see [action types](#the-action-types) |
| `target` | `"panes"` | `"windows"` maps keys to whole windows |
| `tmuxSocket` | `null` | custom `-S` socket; `null` = learned from sessions |
| `brightness` | `1` | master key-LED brightness |
| `inactiveDim` / `highlightActive` | `0.35` / `true` | dim keys that aren't where you are |
| `glow` / `glowBrightness` / `glowStatuses` | `true` / `0.4` / `null` | whole-device wash in the focused session's color |
| `statusStyle` | — | per-status `color` (RGB int), `effect` (`solid`/`breath`/`snake`/`rainbow`/`gradient`/`shallowBreath`/`off`), `speed`, `brightness` |
| `pressDebounceMs` | `60` | chatter guard; must stay well under `doublePressMs` |
| `doublePressMs` / `doublePress` | `600` / `"zoom"` | double-press window and meaning |
| `focusTerminal` / `focusApp` | `true` / `null` | raise the terminal on press; name the app if discovery can't reach it |
| `knobs.left` | `ENC_*` | encoder control names + `turn` / `click` / `confirm` |
| `modeCycle` | `4` | permission modes per Shift+Tab lap — measure yours |
| `pickerIdleMs` / `knobClickMs` | `15000` / `300` | model-list freshness · click debounce |
| `turnSteps` / `turnWindowMs` / `turnIdleMs` | `2` / `80` / `4000` | rotation gearing / net-delta window / part-step decay |
| `joystick` | `{ deadzone: 0.3, … }` | `chargeMs`, `idleDropMs`, `gamePort`, `display` (`tmux`/`chrome`) |
| `reassertMs` | `250` | daemon tick cadence |
| `threadsReassertMs` / `glowReassertMs` | `500` / `750` | unchanged-lighting re-send rate (beats app repaints) |
| `panesTtlMs` / `claudeScanMs` | `200` / `1500` | pane-list / `ps`-scan refresh — decoupled so cheap reads aren't paced by expensive ones |
| `nudgeMs` / `nudgeFloorMs` | `25` / `100` | out-of-band repaint coalescing |
| `staleSessionHours` | `12` | forget sessions older than this |
| `actionCooldownMs` / `actionErrorMs` | `2500` / `8000` | action re-fire guard · error flash duration |
| `debugReports` / `debugTurns` | `false` | `true` logs decoded notifications, `"raw"` adds hex · per-detent turn logging |

</details>

<details><summary><b>Files</b></summary>

| Path | Role |
|---|---|
| `daemon.js` | the service: state, LEDs, key dispatch, control API, game server |
| `cli.js` | the configurator (`claude-micro` on PATH) |
| `hook.py` | Claude Code hook → `state.json` |
| `config.json` / `actions.json` | per-machine config / reusable action library |
| `game/drift.js` · `game/index.html` | the game — terminal and browser editions |
| `bin/review.sh` | headless review runner |
| `extract-sdk.js` | regenerates `lib/` from the installed ChatGPT.app |
| `make-app.sh` / `patch-settings.py` / `install.sh` | app bundle · hook wiring · everything |
| `state.json` / `daemon.log` / `actions/` | runtime state, logs, action-key state |

`lib/` is generated, never vendored — extracted from the ChatGPT.app already
on the machine.

</details>

**Operating it:**

```bash
claude-micro                                     # configure interactively
tail -f ~/.claude/micro/daemon.log               # watch it work
launchctl bootout gui/$UID/com.claude-micro      # stop
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.claude-micro.plist
./install.sh                                     # repair · after ChatGPT.app or Node updates
```

## Limits

- **A session that has never fired a hook shows `idle`**, not its real
  state — process detection proves it's there, not what it's doing.
- **Only one daemon may run** (pidfile-guarded) — a second fights the first
  for the RPC channel and surfaces as write failures and doubled presses.
- **Positional keys reshuffle if you restructure the window** — that's what
  [pinning](#guide-connecting-your-tmux-setup) is for.
- **`unread` clears on a key press**, not when you read the pane some other
  way.
- **A sleeping device eats the first press** as its wake — press again.
- **Sessions outside tmux** get a light, but a press can't focus them.

---

<div align="center">

*Built by driving it — every field note above was hit, diagnosed, and fixed
on real hardware in real sessions.*

</div>
