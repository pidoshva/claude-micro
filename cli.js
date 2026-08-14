#!/usr/bin/env node
/**
 * claude-micro configurator -- an interactive CLI over the daemon's control
 * API. Assign actions to keys, connect keys to your own tmux layout, tune
 * status colors with a live preview on the physical device, and test-fire any
 * key without touching it.
 *
 * The daemon stays the single owner of the HID device; this talks to it over
 * localhost (the same server that hosts the game):
 *
 *   GET  /state       daemon + device + assignments + live tmux pane map
 *   GET  /next-press  long-poll: the next physical press, swallowed not routed
 *   POST /press       synthesize a press through the real dispatch path
 *   POST /preview     temporary lighting override on the agent row
 *
 * Config edits are written straight to config.json, which the daemon
 * hot-reloads -- there is no "apply" step and nothing to restart.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const HERE = __dirname;
const CONFIG_FILE = path.join(HERE, 'config.json');
const SKILLS_DIR = path.join(os.homedir(), '.claude/skills');

const KEY_NAMES = ['AG00', 'AG01', 'AG02', 'AG03', 'AG04', 'AG05',
                   'ACT06', 'ACT07', 'ACT08', 'ACT09', 'ACT10', 'ACT11', 'ACT12'];
const EFFECTS = ['solid', 'breath', 'snake', 'rainbow', 'gradient', 'shallowBreath', 'off'];
const STATUS_HELP = {
  working: 'turn in progress', 'awaiting-approval': 'permission prompt / waiting on you',
  unread: 'turn finished, not yet looked at', idle: 'attached, nothing pending',
  error: 'action failed', empty: 'pane exists, no Claude session',
};

// ---------------------------------------------------------------- config

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function writeConfig(config) {
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_FILE);
}

// ---------------------------------------------------------------- daemon api

function api(method, urlPath, body, timeout = 5000) {
  const port = readConfig().joystick?.gamePort || 4477;
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, timeout }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------- terminal

const out = process.stdout;
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  purple: '\x1b[38;5;135m', gray: '\x1b[38;5;246m', green: '\x1b[38;5;41m',
  orange: '\x1b[38;5;208m', red: '\x1b[38;5;203m',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rgb(colorInt, scale = 1) {
  const r = Math.round(((colorInt >> 16) & 0xff) * scale);
  const g = Math.round(((colorInt >> 8) & 0xff) * scale);
  const b = Math.round((colorInt & 0xff) * scale);
  return { r, g, b };
}

function block(colorInt, scale = 1) {
  const { r, g, b } = rgb(colorInt, scale);
  return `\x1b[38;2;${r};${g};${b}m██${C.reset}`;
}

function swatch(colorInt) {
  const { r, g, b } = rgb(colorInt);
  return `\x1b[48;2;${r};${g};${b}m      ${C.reset}`;
}

let keyQueue = [];
let keyWaiter = null;

/**
 * Split a stdin chunk into individual key tokens. Fast input -- keyboard
 * auto-repeat, or a second keystroke landing before the first is read --
 * arrives as one chunk ("\x1b[B\x1b[B\r"), and comparing whole chunks
 * silently dropped everything batched.
 */
function tokenize(s) {
  const keys = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b' && s[i + 1] === '[') {
      let j = i + 2;
      while (j < s.length && !(s[j] >= '@' && s[j] <= '~')) j++;
      keys.push(s.slice(i, j + 1)); i = j + 1;
    } else {
      keys.push(s[i]); i++;
    }
  }
  return keys;
}

function startInput() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', buf => {
    for (const k of tokenize(buf.toString('latin1'))) {
      if (k === '\x03') quit();
      if (keyWaiter) { const w = keyWaiter; keyWaiter = null; w(k); }
      else keyQueue.push(k);
    }
  });
}

function readKey(timeoutMs) {
  if (keyQueue.length) return Promise.resolve(keyQueue.shift());
  return new Promise(r => {
    let timer = null;
    const waiter = k => { if (timer) clearTimeout(timer); r(k); };
    if (timeoutMs) {
      timer = setTimeout(() => { if (keyWaiter === waiter) keyWaiter = null; r(null); }, timeoutMs);
      timer.unref();
    }
    keyWaiter = waiter;
  });
}

function quit() {
  out.write('\x1b[?25h\x1b[0m\n');
  process.exit(0);
}

/**
 * Home + draw + erase: repaints in place without the blank flash of a clear.
 * Every line clears to EOL as it's drawn, or shorter lines leave the previous
 * frame's tails visible to their right.
 */
function frame(content) {
  out.write('\x1b[H' + content.split('\n').join('\x1b[K\n') + '\x1b[J');
}

async function withSpinner(text, promise) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  let i = 0;
  while (!done) {
    out.write(`\r  ${C.purple}${frames[i++ % frames.length]}${C.reset} ${text} \x1b[K`);
    await sleep(80);
  }
  out.write('\r\x1b[K');
  return promise;
}

function flash(message, color = C.green) {
  out.write(`\n  ${color}${message}${C.reset}\n`);
  return sleep(1000);
}

// ---------------------------------------------------------------- device map

/**
 * The main screen's centerpiece: the physical device drawn with each key in
 * its LIVE color -- the terminal mirrors the LEDs, refreshed in place. Agent
 * keys carry session state; the action row shows its assignments.
 */
function deviceMap(state) {
  if (!state) return `  ${C.dim}(daemon unreachable -- start it and colors go live)${C.reset}\n`;
  const config = readConfig();
  const bySlot = Object.fromEntries(state.slots.map(s => [s.name, s]));

  const agent = KEY_NAMES.slice(0, 6).map((name, i) => {
    const slot = bySlot[name];
    const style = slot && slot.status ? config.statusStyle[slot.status] : null;
    const scale = slot && slot.status === 'empty' ? 0.25 : 1;
    return style ? block(style.color, scale * (style.brightness ?? 1)) : `${C.dim}▒▒${C.reset}`;
  });

  const action = KEY_NAMES.slice(6).map((name, i) => {
    const entry = config.keys[name];
    const label = !entry || entry.action === 'none' ? '·'
      : (entry.label || entry.action).slice(0, 8);
    const n = i + 7;
    return label === '·' ? `${C.dim}${n}·${C.reset}` : `${C.gray}${n}·${C.reset}${label}`;
  });

  const knob = config.knobs.left.turn === 'mode' ? `${C.purple}◉${C.reset} knob` : `${C.dim}◉${C.reset}`;
  const joy = `${C.purple}✛${C.reset} joystick`;

  return [
    `   ${agent.join(' ')}    ${knob}   ${joy}`,
    `   ${C.dim}1  2  3  4  5  6${C.reset}`,
    `   ${action.join('  ')}`,
    '',
  ].join('\n');
}

function headerLine(state) {
  const daemon = !!state;
  const device = daemon && state.connected;
  const status = daemon
    ? `daemon ${C.green}up${C.reset} · device ${device ? C.green + 'connected' : C.orange + 'asleep/away'}${C.reset}`
    : `daemon ${C.red}NOT RUNNING${C.reset} · edits still save`;
  return `${C.bold}${C.purple}claude-micro${C.reset} configurator   ${status}\n` +
         `${C.dim}${'─'.repeat(Math.min(72, out.columns || 72))}${C.reset}\n`;
}

// ---------------------------------------------------------------- menu

/**
 * Arrow-key menu. When opts.live is set, the screen re-renders every
 * refreshMs with fresh daemon state -- that's what animates the device map.
 */
async function menu(title, items, opts = {}) {
  let cursor = Math.max(0, opts.cursor || 0);
  let state = null;
  while (true) {
    if (opts.live || state === null) {
      const r = await api('GET', '/state', null, 900);
      state = r.status === 200 ? r.body : null;
    }
    let s = headerLine(state);
    if (opts.live) s += deviceMap(state) + '\n';
    if (title) s += `${C.bold}${title}${C.reset}\n\n`;
    items.forEach((item, i) => {
      const sel = i === cursor;
      const marker = sel ? `${C.purple}❯${C.reset}` : ' ';
      const label = sel ? `${C.bold}${item.label}${C.reset}` : item.label;
      s += `  ${marker} ${label}${item.hint ? `  ${C.dim}${item.hint}${C.reset}` : ''}\n`;
    });
    s += `\n${C.dim}${opts.footer || '↑↓ move · enter select · esc back'}${C.reset}\n`;
    frame(s + '\x1b[?25l');

    const k = await readKey(opts.live ? 600 : undefined);
    if (k === null) continue;                          // live refresh tick
    if (k === '\x1b[A') cursor = (cursor - 1 + items.length) % items.length;
    else if (k === '\x1b[B') cursor = (cursor + 1) % items.length;
    else if (k === '\r' || k === '\n') return items[cursor].value;
    else if (k === '\x1b' || k === 'q') return null;
    else if (/^[1-9]$/.test(k) && Number(k) <= items.length) return items[Number(k) - 1].value;
  }
}

/**
 * Line editor. opts.preview(text) returns a string rendered live on the
 * prompt line as the user types -- how hex input shows its color before
 * anything is saved.
 */
async function input(promptText, initial = '', opts = {}) {
  const paintPreview = text => {
    if (!opts.preview) return;
    // Save cursor, rewrite the prompt line above with the preview, restore.
    out.write(`\x1b7\x1b[1A\r\x1b[K  ${promptText}  ${opts.preview(text) || ''}\x1b8`);
  };
  out.write(`\n  ${promptText}\n  ${C.purple}❯ ${C.reset}\x1b[?25h${initial}`);
  paintPreview(initial);
  let text = initial;
  while (true) {
    const k = await readKey();
    if (k === '\r' || k === '\n') { out.write('\x1b[?25l\n'); return text.trim(); }
    if (k === '\x1b') { out.write('\x1b[?25l\n'); return null; }
    if (k === '\x7f' || k === '\b') {
      if (text) { text = text.slice(0, -1); out.write('\b \b'); paintPreview(text); }
    } else if (k === '\x15') {                          // C-u clears the line
      out.write('\b \b'.repeat(text.length)); text = ''; paintPreview(text);
    } else if (k >= ' ' && k.length === 1) {
      text += k; out.write(k); paintPreview(text);
    }
  }
}

/** Accepts #RRGGBB, RRGGBB, 0xRRGGBB, and #RGB shorthand. Null if not a color. */
function parseHex(text) {
  const t = String(text || '').trim().replace(/^#/, '').replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{6}$/.test(t)) return parseInt(t, 16);
  if (/^[0-9a-fA-F]{3}$/.test(t)) {
    return parseInt(t.split('').map(c => c + c).join(''), 16);
  }
  return null;
}

const PALETTE = [
  ['codex blue', 0x304FFE], ['orange', 0xFF6D00], ['green', 0x00FF4C],
  ['white', 0xFFFFFF], ['red', 0xFF0033], ['purple', 0x8B54F7],
  ['deep purple', 0x5B1FD3], ['cyan', 0x00E5FF], ['pink', 0xFF4081],
  ['yellow', 0xFFD600], ['teal', 0x1DE9B6],
];

/** Preset palette + free hex with a live swatch. Returns an int or null. */
async function pickColor(currentInt) {
  const choice = await menu('Pick a color', [
    ...PALETTE.map(([name, c]) => ({
      label: `${swatch(c)}  #${c.toString(16).padStart(6, '0')}`, hint: name, value: c,
    })),
    { label: 'Custom hex…', hint: '#RRGGBB, RRGGBB, 0xRRGGBB, or #RGB', value: '__hex' },
  ]);
  if (choice === null) return null;
  if (choice !== '__hex') return choice;
  const text = await input('Hex color (live swatch updates as you type):',
    currentInt.toString(16).padStart(6, '0'), {
      preview: t => {
        const c = parseHex(t);
        return c === null ? `${C.dim}...${C.reset}` : `${swatch(c)} #${c.toString(16).padStart(6, '0')}`;
      },
    });
  if (text === null) return null;
  const parsed = parseHex(text);
  if (parsed === null) { await flash(`"${text}" is not a color`, C.orange); return null; }
  return parsed;
}

// ---------------------------------------------------------------- skills

function listSkills() {
  const skills = [];
  try {
    for (const name of fs.readdirSync(SKILLS_DIR)) {
      const file = path.join(SKILLS_DIR, name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const desc = /description:\s*\|?\s*\n?\s*(.+)/.exec(text);
      skills.push({ name, desc: desc ? desc[1].trim().slice(0, 60) : '' });
    }
  } catch {}
  return skills;
}

// ---------------------------------------------------------------- screens

function readActionsLibrary() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, 'actions.json'), 'utf8')); }
  catch { return {}; }
}

function writeActionsLibrary(lib) {
  const file = path.join(HERE, 'actions.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(lib, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}

function describeKey(entry) {
  if (!entry) return `${C.dim}unassigned (ChatGPT app)${C.reset}`;
  if (entry.use) {
    const lib = readActionsLibrary();
    const def = lib[entry.use];
    return def ? `${entry.use} ${C.dim}(library: ${describeKey(def)})${C.reset}`
               : `${C.red}${entry.use} — missing from actions.json${C.reset}`;
  }
  if (entry.action === 'none' || !entry.action) return `${C.dim}unassigned (ChatGPT app)${C.reset}`;
  const by = {
    tmux: () => entry.target ? `pinned to ${entry.target}` : `jump to pane ${entry.index + 1}`,
    review: () => `review (/code-review ${entry.effort || 'high'})`,
    prompt: () => `${entry.label || 'prompt'} (${(entry.text || '').slice(0, 30)})`,
    approve: () => 'approve dialogs',
    deny: () => 'deny dialogs',
    command: () => `run: ${(entry.run || '').slice(0, 34)}${entry.window ? ' (window)' : ''}`,
    keys: () => `send keys: ${(entry.keys || []).join(' ').slice(0, 30)}`,
  };
  return (by[entry.action] || (() => entry.action))();
}

/** Interactive builders for the two custom formats. Return an entry or null. */
async function buildCommandAction() {
  const run = await input('Shell command (runs via bash -lc; $MICRO_PANE, $MICRO_PANE_PATH, $MICRO_SESSION, $MICRO_KEY are set):');
  if (!run) return null;
  const where = await menu('Where should it run?', [
    { label: 'Detached', hint: 'silent; outcome logged, red flash on failure', value: false },
    { label: 'In a tmux window', hint: 'opens focused; for interactive or watch-it things', value: true },
  ]);
  if (where === null) return null;
  const label = await input('Short label (shows on the device map):', run.split(/\s/)[0].split('/').pop());
  return { action: 'command', label: label || 'command', run, ...(where ? { window: true } : {}) };
}

async function buildKeysAction() {
  const seq = await input('Keys in tmux send-keys syntax, space-separated (e.g. "C-o" or "M-t" or "Escape"):');
  if (!seq) return null;
  const label = await input('Short label:', seq.split(/\s+/)[0]);
  return { action: 'keys', label: label || 'keys', keys: seq.split(/\s+/) };
}

/** Offer to promote an inline custom action into the reusable library. */
async function maybeSaveToLibrary(entry) {
  const name = await input('Save to the action library under a name? (empty = just this key):');
  if (!name) return entry;
  const lib = readActionsLibrary();
  lib[name] = { ...entry, description: entry.label || name };
  writeActionsLibrary(lib);
  await flash(`library: ${name} saved — reusable on any key as {"use": "${name}"}`);
  return { use: name };
}

async function keysScreen() {
  while (true) {
    const config = readConfig();
    const items = KEY_NAMES.map((name, i) => ({
      label: `${String(i + 1).padStart(2)} · ${name.padEnd(6)}`,
      hint: describeKey(config.keys[name]),
      value: name,
    }));
    items.push({ label: '⊙ identify — press a key on the device', value: '__identify' });
    const choice = await menu('Keys', items, { footer: '↑↓ move · enter edit · 1-9 jump · esc back' });
    if (choice === null) return;
    if (choice === '__identify') {
      const r = await withSpinner(`${C.orange}press any key on the Micro...${C.reset} (30s, esc on the device won't help)`,
        api('GET', '/next-press', null, 31000));
      if (r.status === 200 && r.body && KEY_NAMES.includes(r.body.k)) await keyEditor(r.body.k);
      else if (r.status === 200 && r.body) await flash(`that was ${r.body.k} — a knob/joystick control, not a key`, C.orange);
      else await flash('no press seen (or daemon unreachable)', C.orange);
      continue;
    }
    await keyEditor(choice);
  }
}

async function pickPane(config) {
  const r = await api('GET', '/state');
  if (r.status !== 200) { await flash('daemon unreachable — cannot list panes', C.orange); return null; }
  const panes = r.body.panes || [];
  if (!panes.length) { await flash('no tmux panes found', C.orange); return null; }
  return menu('Pick a live pane', panes.map(p => ({
    label: `#${String(p.position).padStart(2)} · ${p.coord.padEnd(20)}`,
    hint: `${p.command}${p.hasClaude ? ` · ${C.green}claude ●${C.reset}` : ''}${p.active ? ' · (you are here)' : ''}`,
    value: p,
  })));
}

async function keyEditor(name) {
  while (true) {
    const config = readConfig();
    const current = describeKey(config.keys[name]);
    const library = readActionsLibrary();
    const libraryItems = Object.entries(library).map(([n, def]) => ({
      label: `⚡ ${n}`, hint: def.description || describeKey(def), value: `__lib:${n}`,
    }));
    const choice = await menu(`${name} — currently: ${current}`, [
      { label: 'Jump to a tmux pane…', hint: 'by position, or pinned to an exact pane', value: 'tmux' },
      { label: 'Slash command / prompt…', hint: 'a skill or custom text, typed into the focused session', value: 'prompt' },
      { label: 'Custom: run a command…', hint: 'any shell command, detached or in a tmux window', value: 'command' },
      { label: 'Custom: send keys…', hint: 'raw keystrokes to the focused pane (C-o, M-t, ...)', value: 'keys' },
      ...libraryItems,
      { label: 'Review', hint: '/code-review on the focused session', value: 'review' },
      { label: 'Approve dialogs', hint: 'Enter on the highlighted option', value: 'approve' },
      { label: 'Deny dialogs', hint: 'Esc on the dialog', value: 'deny' },
      { label: 'Nothing', hint: 'leave the key to the ChatGPT app', value: 'none' },
      { label: '▸ Test this key now', hint: 'fires the real action', value: '__test' },
    ]);
    if (choice === null) return;

    if (choice === '__test') { await testKey(name); continue; }

    if (choice.startsWith('__lib:')) {
      config.keys[name] = { use: choice.slice(6) };
      writeConfig(config);
      await flash(`saved — ${name} is now: ${describeKey(config.keys[name])} (daemon hot-reloads)`);
      return;
    }
    if (choice === 'command' || choice === 'keys') {
      const built = choice === 'command' ? await buildCommandAction() : await buildKeysAction();
      if (!built) continue;
      config.keys[name] = await maybeSaveToLibrary(built);
      writeConfig(config);
      await flash(`saved — ${name} is now: ${describeKey(config.keys[name])} (daemon hot-reloads)`);
      return;
    }

    if (choice === 'tmux') {
      const how = await menu('How should this key find its pane?', [
        { label: 'By position…', hint: 'Nth pane, sorted session→window→top→left; survives pane churn', value: 'position' },
        { label: 'Pin a live pane…', hint: 'exact session:window.pane; survives layout reshuffles', value: 'pin' },
      ]);
      if (how === null) continue;
      if (how === 'position') {
        const pane = await pickPane(config);
        if (!pane) continue;
        config.keys[name] = { action: 'tmux', index: pane.position - 1 };
      } else {
        const pane = await pickPane(config);
        if (!pane) continue;
        config.keys[name] = { action: 'tmux', target: pane.coord };
      }
    } else if (choice === 'prompt') {
      const skills = listSkills();
      const pick = await menu('What should it type?', [
        ...skills.map(s => ({ label: `/${s.name}`, hint: s.desc, value: `/${s.name}` })),
        { label: 'Custom text…', hint: 'anything, typed and submitted', value: '__custom' },
      ]);
      if (pick === null) continue;
      const text = pick === '__custom' ? await input('Text to type into the session:') : pick;
      if (!text) continue;
      const label = text.startsWith('/') ? text.slice(1).split(' ')[0] : 'prompt';
      config.keys[name] = { action: 'prompt', label, text };
    } else if (choice === 'review') {
      const effort = await menu('Review effort', ['low', 'medium', 'high', 'xhigh'].map(e =>
        ({ label: e, value: e }))) || 'high';
      config.keys[name] = { action: 'review', effort };
    } else if (choice === 'approve' || choice === 'deny') {
      config.keys[name] = { action: choice, cooldownMs: 700 };
    } else {
      config.keys[name] = { action: 'none' };
    }
    writeConfig(config);
    await flash(`saved — ${name} is now: ${describeKey(config.keys[name])} (daemon hot-reloads)`);
    return;
  }
}

async function tmuxScreen() {
  while (true) {
    const config = readConfig();
    const r = await api('GET', '/state');
    const panes = r.status === 200 ? r.body.panes || [] : [];
    const paneRows = panes.slice(0, 8).map(p =>
      `  ${C.dim}#${p.position}${C.reset} ${p.coord.padEnd(22)} ${p.command}` +
      `${p.hasClaude ? ` ${C.green}●${C.reset}` : ''}${p.active ? `  ${C.purple}← you${C.reset}` : ''}`);
    const choice = await menu(
      `Tmux — live panes in key order:\n${paneRows.join('\n') || `  ${C.dim}(none visible)${C.reset}`}\n`, [
        { label: `Target mode: ${config.target}`, hint: 'panes = individual panes · windows = whole windows', value: 'mode' },
        { label: `Socket: ${config.tmuxSocket || 'auto'}`, hint: 'auto = learned from sessions; set for a custom -S socket', value: 'socket' },
        { label: 'Reassign keys 1-6 to panes…', hint: 'shortcut into the Keys editor', value: 'keys' },
      ]);
    if (choice === null) return;
    if (choice === 'mode') {
      config.target = config.target === 'panes' ? 'windows' : 'panes';
      writeConfig(config);
      await flash(`saved — keys now target ${config.target}`);
    } else if (choice === 'socket') {
      const v = await input('Socket path (empty = auto):', config.tmuxSocket || '');
      if (v === null) continue;
      config.tmuxSocket = v || null;
      writeConfig(config);
      await flash('saved (daemon hot-reloads)');
    } else if (choice === 'keys') {
      await keysScreen();
    }
  }
}

async function colorsScreen() {
  while (true) {
    const config = readConfig();
    const items = Object.entries(config.statusStyle).map(([status, style]) => ({
      label: `${swatch(style.color)}  ${status.padEnd(18)}`,
      hint: `${style.effect}${style.speed ? ` ${style.speed}` : ''} · ${STATUS_HELP[status] || ''}`,
      value: status,
    }));
    const choice = await menu('Status colors', items, { footer: '↑↓ move · enter edit · esc back' });
    if (choice === null) return;
    await colorEditor(choice);
  }
}

/** A terminal mirror of what the device is doing during a preview. */
async function animatePreview(style, ms = 2600) {
  const steps = Math.floor(ms / 60);
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    let cells;
    if (style.effect === 'breath' || style.effect === 'shallowBreath') {
      const b = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * Math.PI * 4));
      cells = Array(6).fill(block(style.color, b * (style.brightness ?? 1)));
    } else if (style.effect === 'snake') {
      const head = Math.floor(t * 12) % 6;
      cells = Array.from({ length: 6 }, (_, j) => block(style.color, j === head ? 1 : 0.15));
    } else if (style.effect === 'rainbow') {
      cells = Array.from({ length: 6 }, (_, j) => {
        const h = ((t * 2 + j / 6) % 1) * 6;
        const x = Math.floor(h), f = h - x;
        const rgbv = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][x % 6];
        const c = (Math.round(rgbv[0] * 255) << 16) | (Math.round(rgbv[1] * 255) << 8) | Math.round(rgbv[2] * 255);
        return block(c);
      });
    } else {
      cells = Array(6).fill(block(style.color, style.brightness ?? 1));
    }
    out.write(`\r  ${cells.join(' ')}  ${C.dim}← mirroring the device${C.reset}\x1b[K`);
    await sleep(60);
  }
  out.write('\r\x1b[K');
}

async function colorEditor(status) {
  while (true) {
    const config = readConfig();
    const style = config.statusStyle[status];
    const choice = await menu(
      `${status}  ${swatch(style.color)}  #${style.color.toString(16).padStart(6, '0')}`, [
        { label: 'Color…', hint: 'palette, or any hex (#RRGGBB / #RGB / 0x…)', value: 'color' },
        { label: `Effect: ${style.effect}`, hint: EFFECTS.join(' / '), value: 'effect' },
        { label: `Speed: ${style.speed ?? 0}`, hint: '0-1, for animated effects', value: 'speed' },
        { label: `Brightness: ${style.brightness ?? 1}`, hint: '0-1 multiplier', value: 'brightness' },
        { label: '▸ Preview on the device', hint: 'lights all six keys + mirrors here', value: '__preview' },
      ]);
    if (choice === null) return;

    const preview = async () => {
      const r = await api('POST', '/preview', {
        ms: 2800,
        items: [{ color: style.color, effect: style.effect, speed: style.speed ?? 0,
                  brightness: style.brightness ?? 1 }],
      });
      if (r.status === 204) await animatePreview(style);
      else await flash('daemon unreachable — no preview', C.orange);
    };

    if (choice === '__preview') { await preview(); continue; }
    if (choice === 'color') {
      const picked = await pickColor(style.color);
      if (picked === null) continue;
      style.color = picked;
    } else if (choice === 'effect') {
      const effect = await menu('Effect', EFFECTS.map(e => ({ label: e, value: e })));
      if (effect === null) continue;
      style.effect = effect;
    } else if (choice === 'speed' || choice === 'brightness') {
      const v = await input(`${choice} (0-1):`, String(style[choice] ?? (choice === 'speed' ? 0 : 1)));
      if (v === null || isNaN(Number(v))) continue;
      style[choice] = Math.max(0, Math.min(1, Number(v)));
    }
    writeConfig(config);
    await preview();
    await flash('saved (daemon hot-reloads)');
  }
}

async function testKey(name) {
  const r = await api('POST', '/press', { k: name, act: 1 });
  if (r.status !== 204) { await flash('daemon unreachable — cannot test', C.orange); return; }
  out.write(`\n  ${C.green}pressed ${name}${C.reset} — the focused pane reacts; daemon log says:\n`);
  await withSpinner('waiting for the daemon...', sleep(1200));
  try {
    const log = fs.readFileSync(path.join(HERE, 'daemon.log'), 'utf8').trim().split('\n');
    for (const line of log.slice(-3)) out.write(`  ${C.dim}${line.slice(0, 110)}${C.reset}\n`);
  } catch {}
  out.write(`\n  ${C.dim}any key to continue${C.reset}\n`);
  await readKey();
}

async function testScreen() {
  while (true) {
    const config = readConfig();
    const assigned = KEY_NAMES.filter(n => config.keys[n] && config.keys[n].action !== 'none');
    const choice = await menu('Test a key (fires its real action)',
      assigned.map(n => ({ label: n, hint: describeKey(config.keys[n]), value: n })));
    if (choice === null) return;
    await testKey(choice);
  }
}

async function knobScreen() {
  while (true) {
    const config = readConfig();
    const knob = config.knobs.left;
    const choice = await menu('Knob', [
      { label: `Turn: ${knob.turn}`, hint: 'mode = cycle permission modes · none', value: 'turn' },
      { label: `Click: ${knob.click}`, hint: 'model = open the model picker · none', value: 'click' },
      { label: `Mode cycle length: ${config.modeCycle}`, hint: 'permission modes per Shift+Tab lap', value: 'modeCycle' },
      { label: `Model confirm: ${knob.confirm || 'session'}`, hint: 'session = s · default = Enter (global!)', value: 'confirm' },
    ]);
    if (choice === null) return;
    if (choice === 'turn') knob.turn = knob.turn === 'mode' ? 'none' : 'mode';
    else if (choice === 'click') knob.click = knob.click === 'model' ? 'none' : 'model';
    else if (choice === 'confirm') knob.confirm = (knob.confirm || 'session') === 'session' ? 'default' : 'session';
    else if (choice === 'modeCycle') {
      const v = await input('Modes per lap (count them with Shift+Tab):', String(config.modeCycle));
      if (v === null || !/^\d+$/.test(v)) continue;
      config.modeCycle = Number(v);
    }
    writeConfig(config);
    await flash('saved (daemon hot-reloads)');
  }
}

// ---------------------------------------------------------------- main

async function splash() {
  const lines = [
    '        _                 _                    _                ',
    '   ___ | | __ _ _   _  __| | ___   _ __ ___  (_) ___ _ __ ___  ',
    '  / __|| |/ _` | | | |/ _` |/ _ \\ | \'_ ` _ \\ | |/ __| \'__/ _ \\ ',
    ' | (__ | | (_| | |_| | (_| |  __/ | | | | | || | (__| | | (_) |',
    '  \\___||_|\\__,_|\\__,_|\\__,_|\\___| |_| |_| |_||_|\\___|_|  \\___/ ',
  ];
  out.write('\x1b[2J\x1b[H\x1b[?25l\n');
  for (const line of lines) {
    out.write(`${C.purple}${line}${C.reset}\n`);
    await sleep(45);
  }
  await sleep(250);
}

async function main() {
  startInput();
  await splash();
  while (true) {
    const choice = await menu('', [
      { label: 'Keys', hint: 'assign actions to the 13 keys', value: 'keys' },
      { label: 'Tmux', hint: 'connect keys to your panes, windows, socket', value: 'tmux' },
      { label: 'Knob', hint: 'turn & click behavior', value: 'knob' },
      { label: 'Colors', hint: 'status colors, previewed live on the device', value: 'colors' },
      { label: 'Test', hint: 'fire any key\'s action from here', value: 'test' },
      { label: 'Quit', value: 'quit' },
    ], { live: true, footer: '↑↓ move · enter select · q quit · map refreshes live' });
    if (choice === null || choice === 'quit') quit();
    if (choice === 'keys') await keysScreen();
    if (choice === 'tmux') await tmuxScreen();
    if (choice === 'knob') await knobScreen();
    if (choice === 'colors') await colorsScreen();
    if (choice === 'test') await testScreen();
  }
}

main().catch(e => { out.write('\x1b[?25h\n' + e.stack + '\n'); process.exit(1); });
