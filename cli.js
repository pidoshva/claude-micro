#!/usr/bin/env node
/**
 * claude-micro configurator -- an interactive CLI over the daemon's control
 * API. Assign actions to keys, tune status colors with a live preview on the
 * physical device, and test-fire any key without touching it.
 *
 * The daemon stays the single owner of the HID device; this talks to it over
 * localhost (the same server that hosts the game):
 *
 *   GET  /state       daemon + device + key assignments
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

function swatch(colorInt) {
  const r = (colorInt >> 16) & 0xff, g = (colorInt >> 8) & 0xff, b = colorInt & 0xff;
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

function readKey() {
  if (keyQueue.length) return Promise.resolve(keyQueue.shift());
  return new Promise(r => { keyWaiter = r; });
}

function quit() {
  out.write('\x1b[?25h\x1b[0m\n');
  process.exit(0);
}

function clear() { out.write('\x1b[2J\x1b[H'); }

async function header() {
  const state = await api('GET', '/state');
  const daemon = state.status === 200;
  const device = daemon && state.body.connected;
  const line = daemon
    ? `daemon ${C.green}up${C.reset} · device ${device ? C.green + 'connected' : C.orange + 'asleep/away'}${C.reset}`
    : `daemon ${C.red}NOT RUNNING${C.reset} -- edits still save; preview/test need it`;
  out.write(`${C.bold}${C.purple}claude-micro${C.reset} configurator   ${line}\n`);
  out.write(C.dim + '─'.repeat(Math.min(70, out.columns || 70)) + C.reset + '\n');
  return state.body;
}

/**
 * Arrow-key menu. items: { label, hint, value }. Returns value, or null on esc.
 * Number keys jump-select, which doubles as documentation of key positions.
 */
async function menu(title, items, opts = {}) {
  let cursor = Math.max(0, opts.cursor || 0);
  while (true) {
    clear();
    await header();
    out.write(`${C.bold}${title}${C.reset}\n\n`);
    items.forEach((item, i) => {
      const sel = i === cursor;
      const marker = sel ? `${C.purple}❯${C.reset}` : ' ';
      const label = sel ? `${C.bold}${item.label}${C.reset}` : item.label;
      out.write(`  ${marker} ${label}${item.hint ? `  ${C.dim}${item.hint}${C.reset}` : ''}\n`);
    });
    out.write(`\n${C.dim}${opts.footer || '↑↓ move · enter select · esc back'}${C.reset}\n`);
    out.write('\x1b[?25l');

    const k = await readKey();
    if (k === '\x1b[A') cursor = (cursor - 1 + items.length) % items.length;
    else if (k === '\x1b[B') cursor = (cursor + 1) % items.length;
    else if (k === '\r' || k === '\n') return items[cursor].value;
    else if (k === '\x1b' || k === 'q') return null;
    else if (/^[1-9]$/.test(k) && Number(k) <= items.length) return items[Number(k) - 1].value;
  }
}

async function input(promptText, initial = '') {
  out.write(`\n${promptText}\n${C.purple}❯ ${C.reset}\x1b[?25h${initial}`);
  let text = initial;
  while (true) {
    const k = await readKey();
    if (k === '\r' || k === '\n') { out.write('\x1b[?25l\n'); return text.trim(); }
    if (k === '\x1b') { out.write('\x1b[?25l\n'); return null; }
    if (k === '\x7f' || k === '\b') {
      if (text) { text = text.slice(0, -1); out.write('\b \b'); }
    } else if (k >= ' ' && k.length === 1) {
      text += k; out.write(k);
    }
  }
}

function flash(message) {
  out.write(`\n${C.green}${message}${C.reset}\n`);
  return new Promise(r => setTimeout(r, 900));
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

function describeKey(entry) {
  if (!entry || entry.action === 'none' || !entry.action) return `${C.dim}unassigned (ChatGPT app)${C.reset}`;
  const by = {
    tmux: () => `jump to pane ${entry.index + 1}`,
    review: () => `review (/code-review ${entry.effort || 'high'})`,
    prompt: () => `${entry.label || 'prompt'} (${(entry.text || '').slice(0, 30)})`,
    approve: () => 'approve dialogs',
    deny: () => 'deny dialogs',
  };
  return (by[entry.action] || (() => entry.action))();
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
    const choice = await menu('Keys', items, { footer: '↑↓ move · enter edit · esc back' });
    if (choice === null) return;
    if (choice === '__identify') {
      out.write(`\n${C.orange}press any key on the Micro (30s)...${C.reset}\n`);
      const r = await api('GET', '/next-press', null, 31000);
      if (r.status === 200 && r.body && KEY_NAMES.includes(r.body.k)) await keyEditor(r.body.k);
      else if (r.status === 200 && r.body) await flash(`that was ${r.body.k} — a knob/joystick control, not a key`);
      else await flash('no press seen (or daemon unreachable)');
      continue;
    }
    await keyEditor(choice);
  }
}

async function keyEditor(name) {
  while (true) {
    const config = readConfig();
    const current = describeKey(config.keys[name]);
    const choice = await menu(`${name} — currently: ${current}`, [
      { label: 'Jump to a tmux pane…', hint: 'position-ordered pane index', value: 'tmux' },
      { label: 'Slash command / prompt…', hint: 'a skill or custom text, typed into the focused session', value: 'prompt' },
      { label: 'Review', hint: '/code-review on the focused session', value: 'review' },
      { label: 'Approve dialogs', hint: 'Enter on the highlighted option', value: 'approve' },
      { label: 'Deny dialogs', hint: 'Esc on the dialog', value: 'deny' },
      { label: 'Nothing', hint: 'leave the key to the ChatGPT app', value: 'none' },
      { label: '▸ Test this key now', hint: 'fires the real action', value: '__test' },
    ]);
    if (choice === null) return;

    if (choice === '__test') { await testKey(name); continue; }

    if (choice === 'tmux') {
      const idx = await input('Pane position (1 = first pane, top-left first):', '1');
      if (idx === null || !/^\d+$/.test(idx)) continue;
      config.keys[name] = { action: 'tmux', index: Number(idx) - 1 };
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

async function colorEditor(status) {
  while (true) {
    const config = readConfig();
    const style = config.statusStyle[status];
    const choice = await menu(
      `${status}  ${swatch(style.color)}  #${style.color.toString(16).padStart(6, '0')}`, [
        { label: 'Color…', hint: 'hex, e.g. FF6D00', value: 'color' },
        { label: `Effect: ${style.effect}`, hint: EFFECTS.join(' / '), value: 'effect' },
        { label: `Speed: ${style.speed ?? 0}`, hint: '0-1, for animated effects', value: 'speed' },
        { label: `Brightness: ${style.brightness ?? 1}`, hint: '0-1 multiplier', value: 'brightness' },
        { label: '▸ Preview on the device', hint: 'lights all six keys for 3s', value: '__preview' },
      ]);
    if (choice === null) return;

    if (choice === '__preview') {
      const r = await api('POST', '/preview', {
        ms: 3000,
        items: [{ color: style.color, effect: style.effect, speed: style.speed ?? 0,
                  brightness: style.brightness ?? 1 }],
      });
      await flash(r.status === 204 ? 'previewing on the device…' : 'daemon unreachable — no preview');
      continue;
    }
    if (choice === 'color') {
      const hex = await input('Hex color (RRGGBB):', style.color.toString(16).padStart(6, '0'));
      if (hex === null || !/^[0-9a-fA-F]{6}$/.test(hex)) continue;
      style.color = parseInt(hex, 16);
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
    // Show the edit on the hardware immediately -- the whole point of tuning
    // colors interactively is seeing them on the actual LEDs, not in a hex code.
    await api('POST', '/preview', {
      ms: 2000,
      items: [{ color: style.color, effect: style.effect, speed: style.speed ?? 0,
                brightness: style.brightness ?? 1 }],
    });
    await flash('saved + previewing (daemon hot-reloads)');
  }
}

async function testKey(name) {
  const r = await api('POST', '/press', { k: name, act: 1 });
  if (r.status !== 204) { await flash('daemon unreachable — cannot test'); return; }
  out.write(`\n${C.green}pressed ${name}${C.reset} — the focused pane reacts; daemon log says:\n`);
  await new Promise(res => setTimeout(res, 1200));
  try {
    const log = fs.readFileSync(path.join(HERE, 'daemon.log'), 'utf8').trim().split('\n');
    for (const line of log.slice(-3)) out.write(`  ${C.dim}${line.slice(0, 110)}${C.reset}\n`);
  } catch {}
  out.write(`\n${C.dim}any key to continue${C.reset}\n`);
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

async function main() {
  startInput();
  out.write('\x1b[?25l');
  while (true) {
    const choice = await menu('', [
      { label: 'Keys', hint: 'assign actions to the 13 keys', value: 'keys' },
      { label: 'Knob', hint: 'turn & click behavior', value: 'knob' },
      { label: 'Colors', hint: 'status colors, previewed live on the device', value: 'colors' },
      { label: 'Test', hint: 'fire any key\'s action from here', value: 'test' },
      { label: 'Quit', value: 'quit' },
    ]);
    if (choice === null || choice === 'quit') quit();
    if (choice === 'keys') await keysScreen();
    if (choice === 'knob') await knobScreen();
    if (choice === 'colors') await colorsScreen();
    if (choice === 'test') await testScreen();
  }
}

main().catch(e => { out.write('\x1b[?25h\n' + e.stack + '\n'); process.exit(1); });
