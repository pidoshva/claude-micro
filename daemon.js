#!/usr/bin/env node
/**
 * claude-micro -- turns the Codex Micro's agent keys into a tmux switcher lit
 * by Claude Code session state. Nothing here talks to Codex.
 *
 * Each configured key owns one tmux target (a pane by default), assigned by
 * position rather than by recency, so a key always means the same place:
 *
 *     key i  ->  targets sorted by session, window, then top, then left
 *
 * Press a key to jump there. Its color shows the Claude Code session running
 * in that pane, or a dim white if there isn't one.
 *
 * Two channels to the same device, because each one only works one way:
 *
 *   writes  -- @worklouder/device-kit-oai (RPCApiOAI.sendThreadsLighting)
 *   reads   -- a raw node-hid handle, parsed here
 *
 * The read path is hand-rolled on purpose. This firmware emits notifications
 * as {"m":"v.oai.hid","p":{"k":"AG02","act":1}}, but the bundled kit's
 * dispatcher only matches JSON-RPC style {method, params}, so its
 * onHidReceived() never fires. Raw reports arrive fine.
 *
 * Both handles are non-exclusive, so this coexists with the ChatGPT app. The
 * app repaints all six keys whenever its own state changes, which would stomp a
 * one-shot write -- hence the re-assert loop. Leave every key this daemon owns
 * UNASSIGNED in the app's Codex Micro settings: the app paints unassigned keys
 * "off" and then stops changing, so nothing contends for them.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HERE = __dirname;
const LIB = path.join(HERE, 'lib/node_modules/@worklouder/device-kit-oai');
const NODE_HID = path.join(LIB, 'node_modules/@worklouder/wl-device-kit/node_modules/node-hid');
const STATE_FILE = path.join(HERE, 'state.json');
const CONFIG_FILE = path.join(HERE, 'config.json');
const LOG_FILE = path.join(HERE, 'daemon.log');
const PID_FILE = path.join(HERE, 'daemon.pid');
const WL_VID = 0x303a;
const VENDOR_USAGE_PAGE = 0xff00;
const RECONNECT_MIN_MS = 0;            // first retry after a drop: the next tick
const RECONNECT_MAX_MS = 2000;
const WRITE_FAILURE_LIMIT = 4;

const kit = require(LIB);
const hid = require(NODE_HID);
const { WLDeviceDiscovery, WLDeviceCommImpl, RPCApiOAI, OAILightingEffect: FX } = kit;

// ---------------------------------------------------------------- logging

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

function rotateLog() {
  try {
    if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch {}
}

// ---------------------------------------------------------------- config

let config = {};
function loadConfig() {
  const defaults = {
    slots: [0, 1, 2, 3], target: 'panes', tmuxSocket: null, reassertMs: 250,
    brightness: 1, inactiveDim: 0.35, highlightActive: true, pressDebounceMs: 300,
    glow: true, glowBrightness: 0.4, glowReassertMs: 750, glowStatuses: null,
    actionCooldownMs: 2500, actionErrorMs: 8000,
    staleSessionHours: 12, focusApp: null, statusStyle: {},
    doublePressMs: 600, doublePress: 'zoom', focusTerminal: true,
    debugReports: false, modeCycle: 4, pickerIdleMs: 15000, knobClickMs: 300,
    turnSteps: 2, turnWindowMs: 80, turnIdleMs: 4000, debugTurns: false,
    joystick: { deadzone: 0.3, chargeMs: 2000, idleDropMs: 350, gamePort: 4477, display: 'tmux' },
    panesTtlMs: 200, claudeScanMs: 1500, threadsReassertMs: 500, nudgeMs: 25, nudgeFloorMs: 100,
    knobs: {
      left: { key: null, cw: null, ccw: null, turn: 'mode', click: 'model' },
      right: { key: null, cw: null, ccw: null, turn: 'none', click: 'none' },
    },
  };
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { log('config unreadable, using defaults:', e.message); }
  config = { ...defaults, ...user };
  config.statusStyle = { ...user.statusStyle };
  // Merged per side, so naming a knob's key doesn't drop the rest of its entry.
  config.knobs = Object.fromEntries(['left', 'right'].map(side =>
    [side, { ...defaults.knobs[side], ...((user.knobs || {})[side]) }]));
  config.joystick = { ...defaults.joystick, ...user.joystick };
}

/**
 * The key map is the forward-looking schema: one entry per physical key, each
 * naming an action. A setup CLI can rewrite this file and the daemon picks it up
 * on the next tick without a restart.
 *
 *   "AG00": { "action": "tmux",   "index": 0 }     // switch to the 1st target
 *   "AG04": { "action": "review", "effort": "high" }
 *   "AG05": { "action": "none" }                   // leave it to the app
 *
 * The older flat `slots` array still works, and is read as four tmux keys.
 */
function keyEntries() {
  if (config.keys && typeof config.keys === 'object') {
    return Object.entries(config.keys)
      .map(([name, entry]) => {
        // Agent keys AG00-AG05 and action keys ACT06-ACT12; the number doubles
        // as the LED id, which only exists for the agent row (0-5).
        const m = /^(?:AG0([0-5])|ACT(0[6-9]|1[0-2]))$/.exec(name);
        if (!m || !entry || !entry.action || entry.action === 'none') return null;
        return { ...entry, name, slotId: Number(m[1] ?? m[2]) };
      })
      .filter(Boolean)
      .sort((a, b) => a.slotId - b.slotId);
  }
  return (config.slots || []).map((slotId, index) =>
    ({ name: `AG0${slotId}`, slotId, action: 'tmux', index }));
}

/** Slots with a per-key LED: the agent row. ACT keys have no addressable light. */
function ownedSlotIds() {
  return keyEntries().map(e => e.slotId).filter(id => id <= 5);
}

/** Action keys keep their state in actions/<KEY>.json, written by the runner. */
function readActionState(name) {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, 'actions', `${name}.json`), 'utf8')); }
  catch { return null; }
}

function styleFor(status) {
  const s = config.statusStyle[status];
  if (!s) return null;
  return {
    color: s.color,
    effect: FX[s.effect] ?? FX.solid,
    speed: s.speed ?? 0,
    scale: s.brightness ?? 1,      // per-status multiplier, not an absolute level
  };
}

// ---------------------------------------------------------------- session state

/** state.json is written by hook.py; the daemon only reads it. */
function readSessions() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return []; }
  const cutoff = Date.now() - config.staleSessionHours * 3600 * 1000;
  return Object.entries((raw && raw.sessions) || {})
    .map(([id, s]) => ({ id, ...s }))
    .filter(s => s && s.updated > cutoff)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

/** Newest session per pane, so a pane reused by a new session shows the new one. */
function sessionsByPane() {
  const byPane = new Map();
  for (const s of readSessions()) {          // already newest-first
    if (s.pane && !byPane.has(s.pane)) byPane.set(s.pane, s);
  }
  return byPane;
}

/** Any recorded tmux socket will do; they all point at the same server here. */
function tmuxSocket() {
  if (config.tmuxSocket) return config.tmuxSocket;
  for (const s of readSessions()) {
    if (s.tmux) return String(s.tmux).split(',')[0];
  }
  return null;                                // fall back to tmux's default socket
}

// ---------------------------------------------------------------- tmux

/**
 * Field separator for tmux -F output. NOT a tab: tmux sanitizes control
 * characters in format output when the environment has no usable locale, so
 * under launchd a tab silently arrives as "_" and every line parses as one
 * field. A printable delimiter behaves the same everywhere. LANG is also
 * forced below for the same class of reason.
 */
const SEP = '|;;|';

function tmux(args, timeout = 4000) {
  return new Promise(resolve => {
    const socket = tmuxSocket();
    const argv = socket ? ['-S', socket, ...args] : args;
    const env = { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' };
    execFile('tmux', argv, { timeout, env }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: '', err: (stderr || err.message || '').trim() });
      else resolve({ ok: true, out: stdout, err: '' });
    });
  });
}

const TARGET_FIELDS = {
  panes: ['#{pane_id}', '#{session_name}', '#{window_index}', '#{pane_index}',
          '#{pane_top}', '#{pane_left}', '#{pane_active}', '#{window_active}',
          '#{pane_current_command}', '#{pane_pid}', '#{pane_current_path}',
          '#{window_layout}'],
  windows: ['#{window_id}', '#{session_name}', '#{window_index}', '#{window_index}',
            '0', '0', '#{window_active}', '#{window_active}', '#{pane_current_command}',
            '#{pane_pid}', '#{pane_current_path}', ''],
};

/**
 * Where each pane sits, read from the window's layout string rather than from
 * pane_top/pane_left.
 *
 * A zoomed pane reports itself at 0,0 filling the window, which collides with
 * whatever really lives in the top-left and reshuffles the positional sort --
 * so zooming one pane would silently repoint the keys at different panes.
 * `window_layout` describes the layout ignoring zoom, so positions stay put
 * while a pane is zoomed. Leaf cells are `<w>x<h>,<x>,<y>,<pane id>`; container
 * cells have `{` or `[` where that id would be, so they don't match.
 */
function layoutPositions(layout) {
  const positions = new Map();
  for (const m of String(layout).matchAll(/(\d+)x(\d+),(\d+),(\d+),(\d+)/g)) {
    positions.set(`%${m[5]}`, { left: Number(m[3]), top: Number(m[4]) });
  }
  return positions;
}

let targets = { at: 0, list: [], refreshing: false };
let malformedWarned = false;

/**
 * Which panes are running Claude Code, by pane pid.
 *
 * Hook state only exists for sessions that have fired an event since the hooks
 * were installed, so a live session can otherwise look empty. A pane's shell
 * has `claude` as a child process, which is true from the moment it starts --
 * that's the signal used to show a session as idle until its hooks report
 * something better, and to stop trusting hook state for a pane whose claude
 * has since exited.
 */
async function claudePanePids() {
  const res = await new Promise(resolve => {
    execFile('ps', ['-ax', '-o', 'pid=,ppid=,args='], { timeout: 4000, maxBuffer: 4 << 20 },
      (err, stdout) => resolve(err ? '' : stdout));
  });

  const children = new Map();          // ppid -> [{pid, args}]
  const argsByPid = new Map();
  for (const line of res.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, args] = m;
    argsByPid.set(pid, args);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push({ pid, args });
  }

  const isClaude = args => /(^|\/)claude(\s|$)/.test(args.trim());
  const hasClaude = (pid, depth = 0) => {
    // The pane's own process counts too: a pane whose command IS claude (tmux
    // new-window 'claude ...') has no shell wrapper, so a children-only walk
    // called it empty.
    if (depth === 0 && isClaude(argsByPid.get(String(pid)) || '')) return true;
    if (depth > 3) return false;
    for (const child of children.get(String(pid)) || []) {
      if (isClaude(child.args) || hasClaude(child.pid, depth + 1)) return true;
    }
    return false;
  };
  return hasClaude;
}

/**
 * Which panes are running Claude, cached apart from the pane list.
 *
 * The two move at completely different speeds: where you are changes the
 * instant you press a key, while whether a pane has claude in it changes when
 * you start or quit one. Reading them together meant the whole enumeration ran
 * at the pace of the `ps` scan -- a full process table -- so "where I am" could
 * be a second stale. Now the pane list is cheap enough to re-read every tick
 * and the scan runs on its own slower clock, off the paint path.
 */
let claudeScan = { at: 0, scanning: false, has: () => false };

async function refreshClaudeScan() {
  if (claudeScan.scanning || Date.now() - claudeScan.at < config.claudeScanMs) return;
  claudeScan.scanning = true;
  try {
    claudeScan.has = await claudePanePids();
    claudeScan.at = Date.now();
  } catch (e) {
    log('claude scan failed:', e.message);
  } finally {
    claudeScan.scanning = false;
  }
}

/**
 * Enumerates tmux targets in a stable visual order: session, then window, then
 * top-to-bottom and left-to-right within the window. For a 2x2 grid that is
 * row-major -- top-left, top-right, bottom-left, bottom-right.
 */
async function refreshTargets() {
  if (claudeScan.at === 0) await refreshClaudeScan();   // first paint waits; later ones don't
  else refreshClaudeScan();
  if (targets.refreshing || Date.now() - targets.at < config.panesTtlMs) return;
  targets.refreshing = true;
  try {
    const mode = config.target === 'windows' ? 'windows' : 'panes';
    const cmd = mode === 'windows' ? 'list-windows' : 'list-panes';
    const fields = TARGET_FIELDS[mode];
    const res = await tmux([cmd, '-a', '-F', fields.join(SEP)]);
    if (!res.ok) {
      if (targets.list.length) log('tmux enumeration failed:', res.err);
      targets = { at: Date.now(), list: [], refreshing: false };
      return;
    }
    const list = [];
    for (const line of res.out.split('\n')) {
      if (!line) continue;
      const parts = line.split(SEP);
      if (parts.length < fields.length) {
        if (!malformedWarned) { malformedWarned = true; log('unparseable tmux line:', JSON.stringify(line)); }
        continue;                                     // never let one bad line break the sort
      }
      const [id, session, windowIndex, paneIndex, top, left, active, windowActive,
             command, pid, panePath, layout] = parts;
      const at = layoutPositions(layout).get(id) || { top: Number(top), left: Number(left) };
      list.push({
        id, session, command, pid, path: panePath,
        windowIndex: Number(windowIndex), paneIndex: Number(paneIndex),
        top: at.top, left: at.left,
        active: active === '1' && windowActive === '1',
        hasClaude: false,
      });
    }

    for (const t of list) t.hasClaude = claudeScan.has(t.pid);
    list.sort((a, b) =>
      a.session.localeCompare(b.session) || a.windowIndex - b.windowIndex ||
      a.top - b.top || a.left - b.left);
    targets = { at: Date.now(), list, refreshing: false };
  } catch (e) {
    log('tmux enumeration error:', e.stack || e.message);
    targets.refreshing = false;
  }
}

/** Each owned key, resolved against live tmux state or its action state. */
function assignSlots() {
  const byPane = sessionsByPane();
  return keyEntries().map(entry => {
    if (entry.action !== 'tmux') {
      return { ...entry, kind: 'action', state: readActionState(entry.name) };
    }
    const target = targets.list[entry.index] || null;
    return {
      ...entry, kind: 'tmux', target,
      session: target ? byPane.get(target.id) || null : null,
    };
  });
}

// ---------------------------------------------------------------- device

const OFF = id => ({ id, color: 0, brightness: 0, effect: FX.off, speed: 0 });

const dev = {
  comm: null, api: null, raw: null,
  connected: false, lastAttempt: 0, writing: false, lastPaintedOff: false,
  writeFailures: 0, lastGlowKey: null, lastGlowAt: 0, retryDelay: 0,
  lastThreadsKey: null, lastThreadsAt: 0, paintPending: false,
};

function findVendorPath() {
  for (const d of hid.devices()) {
    if (d.vendorId === WL_VID && d.usagePage === VENDOR_USAGE_PAGE && d.path) return d.path;
  }
  return null;
}

async function teardown() {
  dev.connected = false;
  dev.lastGlowKey = null;              // force a full rewrite on reconnect
  dev.lastThreadsKey = null;
  // A drop is the moment the device is most likely to come straight back --
  // a wake, a radio blip, a write that timed out -- so the retry after one is
  // immediate, and only a device that stays away is backed off.
  dev.lastAttempt = 0;
  dev.retryDelay = RECONNECT_MIN_MS;
  const { comm, raw } = dev;
  dev.comm = dev.api = dev.raw = null;
  try { if (raw) await raw.close(); } catch {}
  try { if (comm) await comm.disconnect(); } catch {}
}

/**
 * Retry pacing: fast while the device might still be there, slowing to a poll
 * for one that's gone. Each failed attempt doubles the wait up to
 * RECONNECT_MAX_MS, and any success resets it -- so a wake is picked up on the
 * next tick, while a Micro left in a drawer is enumerated twice a second at
 * worst rather than four times.
 */
function backOff() {
  dev.retryDelay = Math.min(RECONNECT_MAX_MS, Math.max(250, (dev.retryDelay || 0) * 2));
  return false;
}

async function connect() {
  if (Date.now() - dev.lastAttempt < (dev.retryDelay || 0)) return false;
  dev.lastAttempt = Date.now();

  let device, comm, api, raw = null;
  try {
    [device] = new WLDeviceDiscovery().findWLDevices();
    if (!device) return backOff();                  // asleep or unplugged

    comm = new WLDeviceCommImpl();
    await comm.connect(device);
    api = new RPCApiOAI(comm);
    comm.onConnectionEvent(e => {
      // 1 == DISCONNECTED, 2 == ERROR
      if (e && (e.type === 1 || e.type === 2)) { log('device connection event', JSON.stringify(e)); teardown(); }
    });

    const rawPath = findVendorPath();
    if (rawPath) {
      raw = await hid.HIDAsync.open(rawPath, { nonExclusive: true });
      raw.on('data', onReport);
      raw.on('error', e => { log('raw read error:', e.message); teardown(); });
      raw.on('close', () => { log('raw handle closed'); teardown(); });
    } else {
      log('warning: no 0xFF00 interface found; presses will not be read');
    }
  } catch (e) {
    // A half-open attempt leaves handles behind that would keep the next one
    // from succeeding, so anything opened here is closed before backing off.
    try { if (raw) await raw.close(); } catch {}
    try { if (comm) await comm.disconnect(); } catch {}
    // Missing Input Monitoring isn't a flaky link and retrying can't fix it, so
    // it's said once and then polled at the slowest rate rather than spun on.
    if (/cannot open device/i.test(e.message || '')) {
      warnPermission();
      dev.retryDelay = RECONNECT_MAX_MS;
      return false;
    }
    log('connect failed:', e.message);
    return backOff();
  }

  dev.comm = comm; dev.api = api; dev.raw = raw; dev.connected = true;
  dev.retryDelay = RECONNECT_MIN_MS;
  log(`connected (${device.deviceType}, usb=${device.isUsbConnection}) reads=${!!raw}`);
  return true;
}

// ---------------------------------------------------------------- read path

/**
 * Report layout: 06 02 <len> <ascii json> 0d 0a <zero padding>, 64 bytes.
 * <len> counts the JSON plus its CRLF. Payloads longer than one report are
 * continued in the next, so complete lines are reassembled here.
 */
let rxBuffer = '';

function onReport(buf) {
  if (!buf || !buf.length) return;
  // `debugReports: "raw"` dumps every report as hex, for working out what a
  // control emits when its message shape isn't known yet. RPC acks are skipped:
  // this daemon writes constantly, and their replies would bury everything else.
  if (config.debugReports === 'raw' && !/"result"/.test(buf.toString('latin1'))) {
    log('raw <-', buf.toString('hex'));
  }
  let chunk;
  if (buf[0] === 0x06 && buf.length >= 3) {
    const len = buf[2];
    chunk = buf.slice(3, Math.min(3 + len, buf.length)).toString('latin1');
  } else {
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0) end--;     // trim zero padding
    chunk = buf.slice(0, end).toString('latin1');
  }

  rxBuffer += chunk;
  if (rxBuffer.length > 8192) rxBuffer = rxBuffer.slice(-8192);   // desync guard

  const lines = rxBuffer.split('\r\n');
  rxBuffer = lines.pop();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let msg;
    try { msg = JSON.parse(text); } catch { continue; }
    if (config.debugReports && !('result' in msg)) log('msg <-', text);
    const method = msg.m ?? msg.method;
    const params = msg.p ?? msg.params;
    if (method === 'v.oai.hid' && params) onControl(params);
    // The joystick has its own channel: {"m":"v.oai.rad","p":{"a":0..1,"d":0..1}}
    // -- angle as a fraction of a full turn, distance from center.
    if (method === 'v.oai.rad' && params) onJoystick(params);
  }
}

const lastPress = new Map();

/**
 * One notification carries every control on the device, so the name decides
 * what it is: AG00-AG05 are the agent keys, and anything else is taken to be a
 * knob and matched against the names in `knobs`.
 *
 * Encoder names aren't documented anywhere, and differ by firmware, so an
 * unrecognised control is reported once with its whole payload -- that line is
 * what to copy into `knobs.<side>.key`, and it also shows whether the firmware
 * sends rotation as a signed step or as two separate names.
 */
const unknownControls = new Set();

function reportUnknown(id, params) {
  if (unknownControls.has(id)) return;
  unknownControls.add(id);
  log(`unknown control ${id}: ${JSON.stringify(params)}` +
      ' -- assign it in config.json under keys.<name>, or knobs.left/right for an encoder');
}

function onControl(params) {
  const key = params && params.k;
  // A control that doesn't name itself is still worth reporting: some firmware
  // numbers its encoders in another field, and the payload says which.
  if (typeof key !== 'string') return reportUnknown('(unnamed)', params);
  if (/^(AG0[0-5]|ACT(0[6-9]|1[0-2]))$/.test(key)) return onKey(key, params.act);

  const side = knobSideFor(key);
  if (side) return onKnob(side, key, params);

  reportUnknown(key, params);
}

function onKey(key, act) {
  if (typeof key !== 'string') return;
  if (act !== undefined && act !== 1) return;        // 1 == press; ignore release
  const slot = assignSlots().find(s => s.name === key);
  if (!slot) return;                                 // not ours; the app owns it
  const { slotId } = slot;

  // A second press inside doublePressMs is a double press, so the debounce that
  // swallows key chatter has to be narrower than that window rather than wider
  // than it. Handling a double closes the chain, so a third press starts a new
  // one instead of re-toggling on every press of a leaned-on key.
  const now = Date.now();
  const gap = now - (lastPress.get(slotId) || 0);
  if (gap < config.pressDebounceMs) return;
  const double = gap < config.doublePressMs;
  lastPress.set(slotId, double ? 0 : now);

  if (slot.kind === 'action') { dispatchAction(slot); return; }
  if (!slot.target) { log(`press ${slot.name}: no tmux target at that position`); return; }
  if (double) { doublePressTarget(slot); return; }
  focusTarget(slot);
}

// ---------------------------------------------------------------- press action

/**
 * Focusing a session counts as reading it, so its "unread" light clears --
 * same gesture as tapping a Codex thread key. Tracked in memory against the
 * state stamp we acted on, so the next real hook event supersedes it without
 * the daemon having to write to state.json.
 */
const focusAck = new Map();
const actionAck = new Map();          // action key name -> state stamp already opened

/**
 * Whatever is typed but not yet submitted in a pane's Claude composer.
 *
 * Read off the rendered pane, since there's no other way to see unsubmitted
 * input: the composer is the line beginning with the prompt marker, inside the
 * box rule. Deliberately single-line -- the things this is used for (a PR
 * number, a URL, a branch name) are one line, and taking continuation lines
 * risks swallowing the hint text tmux also renders in that box.
 */
async function readComposer(paneId) {
  // Captured WITH escape codes: styling is the only thing separating typed
  // input from ghost text, and that distinction is everything here.
  const res = await tmux(['capture-pane', '-p', '-e', '-t', paneId]);
  if (!res.ok) return { ready: false, text: '', reason: 'could not read the pane' };
  const rawLines = res.out.split('\n');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = rawLines.map(strip);
  const isRule = l => /^\s*[─—-]{8,}\s*$/.test(l || '');

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*❯\s*(.*?)\s*$/.exec(lines[i]);
    if (!m) continue;
    // The composer is framed by box rules. An unframed `❯` is the cursor of a
    // selection menu -- a trust prompt or permission dialog -- and its
    // highlighted option must never be read as typed input, nor typed into.
    if (!(isRule(lines[i - 1]) && isRule(lines[i + 1]))) {
      return { ready: false, text: '', reason: 'session is waiting on a prompt' };
    }
    let text = m[1].replace(/\s+/g, ' ').trim();
    // GHOST TEXT: hints and unsent-message reminders render FAINT (SGR 2)
    // inside an empty composer. They look exactly like a draft in a plain
    // capture, no keystroke can delete them -- there is nothing to delete --
    // and treating one as typed input once made every draft-clearing press
    // "fail" against text that didn't exist. Faint means empty.
    const rawLine = rawLines[i];
    const afterMarker = rawLine.slice(rawLine.indexOf('❯') + 1);
    if (/\x1b\[2m/.test(afterMarker) || /^(try |\? for |press )/i.test(text)) text = '';
    return { ready: true, text };
  }
  return { ready: false, text: '', reason: 'no Claude composer in that pane' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Empty the composer and verify it emptied.
 *
 * C-u does clear it (verified live) -- what failed was the verification, not
 * the key: the pane was re-captured within milliseconds of the send, before
 * the TUI had repainted, so the old text was still on screen and a clear that
 * had worked was reported as a failure. Each attempt now waits out the repaint
 * and re-reads a few times before concluding anything.
 */
async function clearComposer(paneId, typed) {
  if (!typed) return true;
  // C-e first: C-u kills to line START and BSpace deletes backwards, so with
  // the cursor sitting at the start of the draft both would delete nothing.
  // From the end they clear everything wherever the cursor was left.
  const attempts = [['C-e'], ['C-u'], ['-N', String(typed.length + 5), 'BSpace']];
  let last = { text: typed, reason: '' };
  for (const keys of attempts) {
    await tmux(['send-keys', '-t', paneId, ...keys]);
    for (let i = 0; i < 4; i++) {
      await sleep(120);
      const after = await readComposer(paneId);
      if (after.ready && !after.text) return true;
      last = after.ready ? { text: after.text, reason: '' } : { text: '', reason: after.reason };
    }
  }
  // What survived matters more than that something did: hint text and dialog
  // rows aren't input and no amount of deleting removes them.
  log(`clear failed in ${paneId}: ` +
      (last.reason ? `(${last.reason})` : `composer still shows ${JSON.stringify(last.text.slice(0, 80))}`));
  return false;
}

function writeActionState(slot, status, note) {
  const file = path.join(HERE, 'actions', `${slot.name}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(
      { key: slot.name, status, note: note || '', at: Date.now() }));
    nudge();
  } catch (e) { log('could not write action state:', e.message); }
}

function actionError(slot, note) {
  log(`press ${slot.name}: ${note}`);
  writeActionState(slot, 'error', note);       // red, expires on its own
}

/**
 * Answer a visible permission dialog with one key. The guard is the same
 * composer read the other actions use, inverted: a framed `❯` is a normal
 * prompt, and firing "y" at it would just type a letter into the message --
 * so a dialog must actually be on screen, and "nothing to approve" is an
 * error, not a keystroke.
 */
async function answerDialog(slot, key, word) {
  const active = targets.list.find(t => t.active);
  if (!active) return actionError(slot, 'no active tmux pane');
  if (!active.hasClaude) return actionError(slot, `no Claude session in ${active.id}`);
  const composer = await readComposer(active.id);
  if (composer.ready) return actionError(slot, `nothing to ${word}: no dialog up in ${active.id}`);
  if (!/waiting on a prompt/.test(composer.reason)) return actionError(slot, composer.reason);
  await tmux(['send-keys', '-t', active.id, key]);
  log(`press ${slot.name}: ${word} -> ${active.id}`);
  writeActionState(slot, 'idle', word);
}

const ACTIONS = {
  // Tested against the real dialog: y/n do NOTHING on the numbered permission
  // prompt -- Enter accepts the HIGHLIGHTED option and Esc cancels. Enter over
  // '1' on purpose: the joystick moves the highlight, so approve means
  // "confirm what's selected" (which is "1. Yes" untouched), not "always the
  // first option regardless of what I just pointed at".
  approve(slot) { return answerDialog(slot, 'Enter', 'approve'); },
  deny(slot) { return answerDialog(slot, 'Escape', 'deny'); },

  /**
   * Type a canned prompt into the focused pane's Claude session and submit it.
   * The text lives in config, so what a key asks for is tunable without
   * touching code -- one entry per key:
   *
   *   "ACT06": { "action": "prompt", "label": "standup", "text": "Give me..." }
   *
   * Unlike the review key, anything already typed in the composer is a draft
   * the user means to keep: it's cleared to make room, the prompt is sent, and
   * the draft is typed back afterwards. Pressing mid-turn is fine -- Claude
   * Code queues composer submissions and answers when the current step ends.
   */
  async prompt(slot) {
    const active = targets.list.find(t => t.active);
    if (!active) return actionError(slot, 'no active tmux pane');
    if (!active.hasClaude) return actionError(slot, `no Claude session in ${active.id}`);

    const text = String(slot.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return actionError(slot, `no prompt text configured for ${slot.name}`);

    const composer = await readComposer(active.id);
    if (!composer.ready) return actionError(slot, composer.reason);

    // A draft is stashed, not deleted. Clearing it character-by-character raced
    // the user's own typing -- the verify loop kept seeing the keystrokes they
    // were still making and the press "didn't work" exactly when they were
    // mid-sentence. chat:stash (C-s) empties the composer in one atomic
    // keystroke, and a second C-s after the command goes out brings the draft
    // back. Nothing on this path can lose typed text.
    const draft = composer.text;
    if (draft) {
      await tmux(['send-keys', '-t', active.id, 'C-s']);
      let empty = false;
      for (let i = 0; i < 3 && !empty; i++) {
        await sleep(120);
        const after = await readComposer(active.id);
        empty = after.ready && !after.text;
      }
      // Still non-empty means keystrokes are landing right now; the polite
      // move is to leave the keyboard to its owner.
      if (!empty) return actionError(slot, 'composer is being typed in; press again when done');
    }

    await tmux(['send-keys', '-t', active.id, '-l', text]);
    // A beat between text and Enter: input arriving in one rapid burst can be
    // taken for a paste, and a submit swallowed into a paste is just a newline.
    await sleep(150);
    await tmux(['send-keys', '-t', active.id, 'Enter']);
    if (draft) { await sleep(200); await tmux(['send-keys', '-t', active.id, 'C-s']); }

    log(`press ${slot.name}: sent "${slot.label || 'prompt'}" to ${active.id}` +
        `${draft ? ' (draft stashed and restored)' : ''}`);
    writeActionState(slot, 'idle', slot.label || 'prompt');
  },

  /**
   * Kick off a code review, or open one that's already run. The runner picks
   * the target itself (composer text > uncommitted changes > pushed branch or
   * PR); see bin/review.sh.
   */
  async review(slot) {
    const active = targets.list.find(t => t.active);
    if (!active) return actionError(slot, 'no active tmux pane');
    if (slot.mode === 'headless') return startHeadlessReview(slot, active);

    // Default: run it inside the session you're looking at. The session already
    // knows its own repo and what it has been changing -- better context than
    // anything inferable from the pane's cwd -- and its findings render natively
    // instead of being flattened into a headless transcript.
    if (!active.hasClaude) return actionError(slot, `no Claude session in ${active.id}`);

    const composer = await readComposer(active.id);
    if (!composer.ready) return actionError(slot, composer.reason);

    // Typed text is the review target, so it must not also stay in the prompt.
    const typed = composer.text;
    if (typed && !(await clearComposer(active.id, typed))) {
      return actionError(slot, 'could not clear the composer');
    }

    const cmd = `/code-review ${slot.effort || 'high'}${typed ? ` ${typed}` : ''}`;
    await tmux(['send-keys', '-t', active.id, '-l', cmd]);
    await sleep(150);                    // burst + Enter reads as a paste; see prompt()
    await tmux(['send-keys', '-t', active.id, 'Enter']);
    log(`press ${slot.name}: sent "${cmd}" to ${active.id}`);
    // From here the session's own key shows the work, via its hooks.
    writeActionState(slot, 'idle', cmd);
  },
};

/**
 * The optional headless mode, kept for panes that aren't a Claude session: runs
 * the review in its own detached window via `claude -p`. Off by default --
 * spawning windows behind your back is worse than saying "no session here".
 */
async function startHeadlessReview(slot, active) {
  const composer = active.hasClaude ? await readComposer(active.id) : { text: '' };
  const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cmd = [path.join(HERE, 'bin/review.sh'), slot.name, '', active.path,
               composer.text || '', slot.effort || 'high'].map(quote).join(' ');

  log(`press ${slot.name}: starting headless review in ${active.path}`);
  const res = await tmux(['new-window', '-d', '-P', '-F', '#{window_id}',
                          '-n', 'review', '-c', active.path, cmd]);
  if (!res.ok) return actionError(slot, `could not open review window: ${res.err}`);
  const win = res.out.trim();
  if (win) await tmux(['set-option', '-w', '-t', win, 'remain-on-exit', 'on']);
}

const lastAction = new Map();

async function dispatchAction(slot) {
  const handler = ACTIONS[slot.action];
  if (!handler) { log(`press ${slot.name}: no handler for action "${slot.action}"`); return; }

  // Longer than the key debounce: a second press while a review is being
  // dispatched used to queue a second review (or, in headless mode, open a
  // second window). Per-key override, because the right cooldown depends on
  // the action: permission prompts arrive back to back and answering the next
  // one two seconds later is the point of having the key.
  const now = Date.now();
  const cooldown = slot.cooldownMs ?? config.actionCooldownMs;
  if (now - (lastAction.get(slot.name) || 0) < cooldown) {
    log(`press ${slot.name}: ignored, ${slot.action} just ran`);
    return;
  }
  lastAction.set(slot.name, now);

  try { await handler(slot); }
  catch (e) { log(`action ${slot.action} failed:`, e.stack || e.message); }
}

async function focusTarget({ target, session }) {
  if (session) focusAck.set(session.id, session.updated);
  log(`press -> ${target.id} (${target.session}:${target.windowIndex}` +
      `${config.target === 'windows' ? '' : '.' + target.paneIndex}` +
      `${session ? ' ' + (session.title || '') : ''})`);

  // switch-client moves to the target's session; the follow-ups land on the
  // exact window and pane within it.
  const r = await tmux(['switch-client', '-t', target.id]);
  if (!r.ok) log(`tmux switch-client failed: ${r.err}`);
  await tmux(['select-window', '-t', target.id]);
  if (config.target !== 'windows') await tmux(['select-pane', '-t', target.id]);

  nudge();                              // the key you just pressed is the bright one now
  await focusTerminal(target);
}

/**
 * A second press on the key you're already in. Zooming the pane is the obvious
 * pair to "jump here": the same key grows the pane to the whole window and the
 * one after shrinks it back, which is `resize-pane -Z` -- itself a toggle, so
 * the daemon keeps no zoom state of its own and never disagrees with tmux.
 *
 * In `target: "windows"` mode there is nothing to zoom, so a double press is
 * just another jump.
 */
async function doublePressTarget(slot) {
  const { target } = slot;
  if (config.doublePress !== 'zoom' || config.target === 'windows') return focusTarget(slot);

  // Collapsing is the common case, and by then you are already in the pane --
  // so the jump is skipped rather than replayed. Repeating select-pane and
  // switch-client on the pane you are sitting in adds three round trips before
  // the toggle and, when the window is zoomed, is exactly the kind of thing
  // tmux answers by dropping the zoom on its own.
  const state = await tmux(['display-message', '-p', '-t', target.id,
                            `#{pane_active}${SEP}#{window_active}`]);
  const [paneActive, windowActive] = state.out.trim().split(SEP);
  if (paneActive === '1' && windowActive === '1') await focusTerminal(target);
  else await focusTarget(slot);

  const r = await tmux(['resize-pane', '-Z', '-t', target.id]);
  if (!r.ok) { log(`tmux resize-pane -Z failed: ${r.err}`); return; }
  const zoomed = await tmux(['display-message', '-p', '-t', target.id, '#{window_zoomed_flag}']);
  nudge();
  log(`double press -> ${target.id} ${zoomed.out.trim() === '1' ? 'zoomed' : 'unzoomed'}`);
}

// ---------------------------------------------------------------- terminal focus

/**
 * Pressing a key moves the tmux client, but if the terminal itself isn't the
 * frontmost app you still have to reach for the mouse before you can type --
 * so the jump isn't finished until the window that hosts the target has macOS
 * focus too.
 *
 * Which app that is gets worked out from the tmux client attached to the
 * target's session: walk up its process chain until a macOS .app bundle turns
 * up, and that's the terminal emulator hosting the client. `focusApp` names an
 * app outright for setups where the walk can't get there (a client behind ssh,
 * say), and `focusTerminal: false` turns the whole thing off.
 */
const terminalApps = new Map();          // client pid -> app bundle path

async function focusTerminal(target) {
  if (config.focusApp) {
    execFile('open', ['-a', config.focusApp], { timeout: 4000 }, () => {});
    return;
  }
  if (!config.focusTerminal) return;

  const app = await terminalAppFor(target);
  if (!app) return;
  execFile('open', ['-a', app], { timeout: 4000 }, err => {
    if (err) log(`could not focus ${app}: ${err.message}`);
  });
}

async function terminalAppFor(target) {
  const res = await tmux(['list-clients', '-t', target.session, '-F', '#{client_pid}']);
  if (!res.ok) return null;
  const pid = res.out.split('\n').map(s => s.trim()).filter(Boolean)[0];
  if (!pid) { log(`no tmux client attached to ${target.session}; nothing to focus`); return null; }
  if (terminalApps.has(pid)) return terminalApps.get(pid);

  const app = await appBundleAbove(pid);
  if (!app) log(`could not tell which app hosts tmux client ${pid}; set focusApp to name it`);
  terminalApps.set(pid, app);            // negative results cached too: the answer won't change
  return app;
}

/** Nearest ancestor process running out of a .app bundle, if any. */
async function appBundleAbove(pid) {
  const out = await new Promise(resolve => {
    execFile('ps', ['-ax', '-o', 'pid=,ppid=,args='], { timeout: 4000, maxBuffer: 4 << 20 },
      (err, stdout) => resolve(err ? '' : stdout));
  });

  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.set(m[1], { ppid: m[2], args: m[3] });
  }

  for (let cur = String(pid), depth = 0; cur && cur !== '1' && depth < 12; depth++) {
    const proc = procs.get(cur);
    if (!proc) return null;
    const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(proc.args);
    if (m) return m[1];
    cur = proc.ppid;
  }
  return null;
}

// ---------------------------------------------------------------- knobs

/**
 * A knob rides whichever pane you're in, so it pairs with the keys rather than
 * owning a target of its own: press a key to get somewhere, then turn to change
 * how the session there behaves.
 *
 * Turning walks Claude Code's permission modes. Pressing opens the model list,
 * and while that list is up the knob moves through it and the next press
 * confirms -- so picking a model is turn, turn, press, without touching the
 * keyboard. Anything typed but unsent is put back afterwards, since opening the
 * list has to clear the composer to get `/model` in there.
 */
const KNOB_SIDES = ['left', 'right'];
const CONFIRM_KEYS = { session: 's', default: 'Enter' };

function knobSideFor(key) {
  for (const side of KNOB_SIDES) {
    const cfg = config.knobs[side] || {};
    if ([cfg.key, cfg.cw, cfg.ccw].filter(Boolean).includes(key)) return side;
  }
  return null;
}

/**
 * Rotation as a signed count of detents; 0 for anything that isn't a turn.
 * Firmware sends this either as a signed field or as one name per direction,
 * so both are read.
 */
function turnDelta(cfg, key, params) {
  if (cfg.cw && key === cfg.cw) return 1;
  if (cfg.ccw && key === cfg.ccw) return -1;
  for (const field of ['d', 'dir', 'delta', 'step', 'val', 'v']) {
    const v = Number(params[field]);
    if (Number.isFinite(v) && v !== 0) return v;
  }
  return 0;
}

let picker = null;                      // { pane, at } while the list is up

/**
 * Reading a marker off a rendered pane means reading it at that pane's width.
 * The picker's footer is one long line -- "Enter to set as default · s to use
 * this session only · Esc to cancel" -- which in a 66-column pane wraps between
 * "Esc to" and "cancel", so matching the phrase as written found nothing in
 * exactly the layout the keys exist to serve. Newlines are flattened to spaces
 * before matching, and there's a second marker in case the first scrolls off.
 */
const PICKER_MARKERS = [/Esc to cancel/, /to use this session only/];
const flatten = text => text.replace(/\s+/g, ' ');

/**
 * Whether the model list is really on screen, not just believed to be.
 *
 * The daemon can't see you press Esc, and acting on a stale belief is the
 * expensive kind of wrong: a turn would send Up/Down into the prompt (which
 * walks your history into the composer) and a click would send a keystroke
 * meant for a dialog that isn't there. So the belief is checked against the
 * rendered pane before either one acts, and dropped the moment it's false.
 */
async function pickerActive(paneId) {
  if (!picker || picker.pane !== paneId) return false;
  if (Date.now() - picker.at > config.pickerIdleMs) { picker = null; return false; }
  const res = await tmux(['capture-pane', '-p', '-t', paneId]);
  if (!res.ok || !PICKER_MARKERS.some(re => re.test(flatten(res.out)))) { picker = null; return false; }
  picker.at = Date.now();
  return true;
}

const lastKnobClick = new Map();
const turnState = new Map();          // side -> { sum, at, timer }

/**
 * Smoothing, because the encoder reports a detent for the smallest movement and
 * a brush past the knob shouldn't change anything.
 *
 * Two mechanisms, aimed at two different noises. Detents are collected for
 * `turnWindowMs` and applied as a **net** figure, so a spurious step one way
 * followed by one back cancels instead of becoming two actions. Then
 * `turnSteps` is the gearing: how many detents make one mode change or one move
 * through the list. At `2`, a nudge does nothing and a deliberate turn still
 * works; `1` restores one-for-one.
 *
 * The remainder is kept, so slow deliberate turns still add up -- but only for
 * `turnIdleMs`, after which a lone stray detent decays rather than waiting
 * around to pair with an unrelated one later.
 */
function queueTurn(side, cfg, delta) {
  const st = turnState.get(side) || { sum: 0, at: 0, timer: null };
  const now = Date.now();
  // `debugTurns` reports the raw detent stream -- one line per notification,
  // before any smoothing -- which is the only way to tell an encoder that fires
  // once per click from one that fires four times.
  if (config.debugTurns) log(`turn ${side} ${delta > 0 ? 'cw' : 'ccw'} gap=${now - st.at}ms`);
  if (now - st.at > config.turnIdleMs) st.sum = 0;
  st.sum += delta;
  st.at = now;

  if (!st.timer) {
    st.timer = setTimeout(() => {
      st.timer = null;
      const steps = Math.trunc(st.sum / config.turnSteps);
      st.sum -= steps * config.turnSteps;
      if (steps) knobTurn(side, cfg, steps);
    }, config.turnWindowMs);
    st.timer.unref();
  }
  turnState.set(side, st);
}

async function onKnob(side, key, params) {
  const cfg = config.knobs[side] || {};
  const delta = turnDelta(cfg, key, params);
  if (delta) return queueTurn(side, cfg, delta);
  if (params.act !== 1) return;

  // One press of this encoder arrives as a burst -- eight notifications inside
  // 100ms -- and without this each one acted, so a single click opened the
  // picker and then confirmed it seven times over.
  const now = Date.now();
  if (now - (lastKnobClick.get(side) || 0) < config.knobClickMs) return;
  lastKnobClick.set(side, now);
  return knobClick(side, cfg);
}

/** The pane a knob acts on: wherever you are, the same rule the review key uses. */
function knobPane(side) {
  const pane = targets.list.find(t => t.active);
  if (!pane) { log(`knob ${side}: no active tmux pane`); return null; }
  if (!pane.hasClaude) { log(`knob ${side}: no Claude session in ${pane.id}`); return null; }
  return pane;
}

async function knobTurn(side, cfg, delta) {
  if (cfg.turn === 'none') return;
  const pane = knobPane(side);
  if (!pane) return;

  if (await pickerActive(pane.id)) {
    await tmux(['send-keys', '-t', pane.id, '-N', String(Math.abs(delta)),
                delta > 0 ? 'Down' : 'Up']);
    return;
  }
  if (cfg.turn !== 'mode') return;

  // Shift+Tab only cycles one way, so anticlockwise is a lap minus a step --
  // which is why the number of modes in the cycle is configurable.
  const perDetent = delta > 0 ? 1 : Math.max(1, config.modeCycle - 1);
  const taps = perDetent * Math.abs(delta);
  const r = await tmux(['send-keys', '-t', pane.id, '-N', String(taps), 'BTab']);
  if (!r.ok) log(`knob ${side}: send-keys failed: ${r.err}`);
  else log(`knob ${side}: mode ${delta > 0 ? 'forward' : 'back'} (${taps}x S-Tab) -> ${pane.id}`);
}

/**
 * Claude Code binds the model picker itself (`chat:modelPicker`, meta+p), so
 * the knob asks for it by that key rather than typing `/model` into the prompt.
 *
 * The typing version had to empty the composer first, which meant a click while
 * you were part-way through a message tried to delete what you'd written -- and
 * on a message it couldn't clear, it failed having already mangled it. Nothing a
 * knob does should be able to touch your draft, so nothing here does.
 */
async function knobClick(side, cfg) {
  if (cfg.click !== 'model') return;
  const pane = knobPane(side);
  if (!pane) return;

  if (await pickerActive(pane.id)) {
    picker = null;
    // `s` applies the model to this session; Enter would make it the default
    // for every session you start afterwards. A knob that acts on the pane
    // you're sitting in shouldn't quietly rewrite a global setting, so the
    // narrower of the two is what a click means unless you say otherwise.
    await tmux(['send-keys', '-t', pane.id, CONFIRM_KEYS[cfg.confirm] || CONFIRM_KEYS.session]);
    log(`knob ${side}: model applied in ${pane.id}`);
    return;
  }

  const r = await tmux(['send-keys', '-t', pane.id, cfg.openKey || 'M-p']);
  if (!r.ok) { log(`knob ${side}: could not open the model list: ${r.err}`); return; }
  picker = { pane: pane.id, at: Date.now() };
  log(`knob ${side}: model list open in ${pane.id}`);
}

// ---------------------------------------------------------------- joystick & the game

/**
 * The joystick is a d-pad first and a toy second. With a dialog up in the
 * focused session, flicks land as arrow keys. Otherwise flicks feed the game
 * gesture: one continuous swirl through all four directions -- shown filling
 * across the six agent keys -- opens a little dodge-the-asteroids game in a
 * tmux window, steered by the same joystick. Fly into something and the game
 * is over and the window closes.
 *
 * Same idea as the Codex app's hidden game, rebuilt against a localhost page
 * so it works without the app: the daemon serves the game over HTTP and
 * streams joystick positions to it over SSE.
 */
const joy = {
  visited: new Set(),            // quadrants seen in the current gesture
  lastQuadrant: null, lastMoveAt: 0,
  game: null,                    // { child, windowId, clients: Set<res> } while running
  server: null,
};

/** The app's own quadrant mapping: angle is a fraction of a full turn. */
function quadrantOf(a) {
  if (a >= 0.625 && a < 0.875) return 'up';
  if (a >= 0.125 && a < 0.375) return 'down';
  if (a >= 0.375 && a < 0.625) return 'left';
  return 'right';
}

const ARROW_KEYS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right' };

function joyProgress() {
  return joy.visited.size / 4;
}

let radCount = 0, radWindowAt = 0;

function onJoystick(params) {
  const a = Number(params.a) || 0;
  const d = Number(params.d) || 0;
  const now = Date.now();

  if (joy.game) {                              // in-game: the stick is the controls
    // Rate of packets as the DEVICE delivers them, logged per game window.
    // Compared with the game's own rx counter this splits "Bluetooth is slow"
    // from "the pipeline after it is slow".
    radCount++;
    if (!radWindowAt) radWindowAt = now;
    else if (now - radWindowAt > 5000) {
      log(`joystick from device: ${(radCount / ((now - radWindowAt) / 1000)).toFixed(1)}/s`);
      radWindowAt = now; radCount = 0;
    }
    for (const res of joy.game.clients) {
      res.write(`data: {"a":${a},"d":${d}}\n\n`);
    }
    return;
  }

  if (d < config.joystick.deadzone) {          // released: gesture over, charge dropped
    joy.lastQuadrant = null;                   // re-arm the flick edge
    if (joy.visited.size) { joy.visited.clear(); nudge(); }
    return;
  }

  joy.lastMoveAt = now;
  const q = quadrantOf(a);
  if (q === joy.lastQuadrant) return;          // still deflected the same way
  joy.lastQuadrant = q;
  onFlick(q).catch(e => log('flick failed:', e.message));
}

/**
 * One flick, two meanings, decided by what's on screen. A dialog up in the
 * focused session (permission prompt, model picker, any selection menu) makes
 * the stick a d-pad: the flick lands as an arrow key. Otherwise it feeds the
 * game gesture: the game only triggers after one continuous swirl through ALL
 * FOUR directions -- deliberate enough that navigating menus, or knocking the
 * stick, can never open it by accident.
 */
async function onFlick(q) {
  const active = targets.list.find(t => t.active);
  const dialogUp = active && active.hasClaude && await (async () => {
    const composer = await readComposer(active.id);
    return !composer.ready && /waiting on a prompt/.test(composer.reason);
  })();

  if (dialogUp) {
    await tmux(['send-keys', '-t', active.id, ARROW_KEYS[q]]);
    log(`joystick: ${q} -> ${active.id}`);
    return;
  }

  joy.visited.add(q);
  nudge();
  if (joy.visited.size === 4) {
    joy.visited.clear();
    joy.lastQuadrant = null;
    launchGame().catch(e => log('game launch failed:', e.message));
  }
}

/** The gesture decays on its own too: the stick can stop sending without centering. */
function joyTick() {
  if (joy.visited.size && !joy.game && Date.now() - joy.lastMoveAt > config.joystick.idleDropMs) {
    joy.visited.clear();
    joy.lastQuadrant = null;
    nudge();
  }
}

function gameServer() {
  if (joy.server) return Promise.resolve(joy.server);
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      // Read per request so the game is editable without touching the daemon.
      fs.readFile(path.join(HERE, 'game/index.html'), (err, html) => {
        if (err) { res.writeHead(500); res.end('game file missing'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/events') {
      // Nagle batches the tiny SSE frames -- each joystick packet is ~30 bytes,
      // exactly what it exists to coalesce -- adding tens of ms to a control
      // input that's felt at ~10. Every packet must leave now.
      res.socket.setNoDelay(true);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      });
      res.write(':ok\n\n');
      if (joy.game) {
        joy.game.clients.add(res);
        req.on('close', () => {
          if (!joy.game) return;
          joy.game.clients.delete(res);
          // A game whose last listener vanished without a /gameover was killed
          // from outside (window closed by hand); reap it or it blocks the
          // next charge forever.
          if (joy.game.clients.size === 0) {
            setTimeout(() => {
              if (joy.game && joy.game.clients.size === 0) endGame('window gone');
            }, 1500);
          }
        });
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/gameover') {
      res.writeHead(204); res.end();
      // The page shows its explosion before the window goes away.
      setTimeout(() => endGame('crashed'), 900);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.joystick.gamePort, '127.0.0.1', () => { joy.server = server; resolve(server); });
  });
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function launchGame() {
  if (joy.game) return;
  await gameServer();
  joy.game = { child: null, windowId: null, clients: new Set() };
  const launcher = config.joystick.display === 'chrome' ? launchGameChrome : launchGameTmux;
  await launcher();
  nudge();
}

/**
 * The game lives in a tmux window, not a browser: it opens focused inside the
 * session you're already looking at, needs no macOS window-raising rituals,
 * and when the process exits the window closes itself -- which is what "the
 * game exits" should mean at a terminal. The daemon still owns the window id,
 * so a daemon shutdown takes a running game with it.
 */
async function launchGameTmux() {
  const cmd = `node ${JSON.stringify(path.join(HERE, 'game/drift.js'))} --port ${config.joystick.gamePort}`;
  const r = await tmux(['new-window', '-P', '-F', '#{window_id}', '-n', 'drift', cmd]);
  if (!r.ok) { joy.game = null; log('could not open the game window:', r.err); return; }
  joy.game.windowId = r.out.trim();
  log(`game on: tmux window ${joy.game.windowId}`);
}

/** The browser version, kept behind `joystick.display: "chrome"`. */
async function launchGameChrome() {
  const url = `http://127.0.0.1:${config.joystick.gamePort}/`;
  if (fs.existsSync(CHROME)) {
    const { spawn } = require('child_process');
    const child = spawn(CHROME, [
      `--app=${url}`, '--window-size=960,720', '--window-position=240,120',
      `--user-data-dir=${path.join(HERE, 'game/.chrome-profile')}`,
      '--no-first-run', '--no-default-browser-check',
    ], { stdio: 'ignore' });
    child.on('exit', () => { if (joy.game && joy.game.child === child) endGame('window closed'); });
    joy.game.child = child;
    focusGameWindow(child.pid);
  } else {
    execFile('open', [url], { timeout: 4000 }, () => {});
  }
  log(`game on: ${url}`);
}

/**
 * A window spawned by a background daemon opens BEHIND everything and
 * unfocused -- the game genuinely ran on its first outing while its player,
 * looking at the terminal in front of it, reported that nothing had opened.
 * The spawn is raised by pid via System Events; if that's denied (it needs
 * Automation consent, which the terminal that started the daemon usually
 * has), `open -a` on the app is the blunter fallback.
 */
function focusGameWindow(pid) {
  const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`;
  setTimeout(() => {
    execFile('osascript', ['-e', script], { timeout: 4000 }, err => {
      if (!err) return;
      log('could not raise the game window by pid; using open -a:', err.message.split('\n')[0]);
      execFile('open', ['-a', 'Google Chrome'], { timeout: 4000 }, () => {});
    });
  }, 900);                             // give the window a beat to exist first
}

function endGame(reason) {
  if (!joy.game) return;
  const { child, windowId, clients } = joy.game;
  joy.game = null;
  for (const res of clients) { try { res.end(); } catch {} }
  if (child && child.exitCode === null) { try { child.kill(); } catch {} }
  // The game usually exits first and takes its window with it; this is for a
  // game that got stuck or a daemon going down mid-run.
  if (windowId) tmux(['kill-window', '-t', windowId]).catch(() => {});
  log(`game over (${reason})`);
  nudge();
}

function joyOverlay() {
  if (joy.game) {
    return [0, 1, 2, 3, 4, 5].map(id =>
      ({ id, color: 0xffffff, brightness: 0.7, effect: FX.rainbow, speed: 0.5,
         syncKeysLighting: false, syncAmbientLighting: false }));
  }
  const progress = joyProgress();
  if (progress <= 0) return null;
  const lit = Math.ceil(progress * 6);
  return [0, 1, 2, 3, 4, 5].map(id => id < lit
    ? { id, color: 0xffffff, brightness: 0.25 + 0.75 * progress, effect: FX.solid, speed: 0,
        syncKeysLighting: false, syncAmbientLighting: false }
    : OFF(id));
}

// ---------------------------------------------------------------- write path

/**
 * What a slot should show.
 *
 * A pane with no claude running is "empty" whatever stale hook state says --
 * SessionEnd can be missed if claude is killed. A pane with claude running but
 * no hook state yet reads as idle rather than empty.
 */
function statusOf(slot) {
  if (slot.kind === 'action') {
    const st = slot.state;
    if (!st || !st.status) return 'empty';
    // A failure is worth a red key, but only briefly -- it refers to one press,
    // not to a condition that persists.
    if (st.status === 'error' && Date.now() - (st.at || 0) > config.actionErrorMs) return 'empty';
    // A finished report reads as unread until the key is pressed to open it,
    // exactly like a session's finished turn.
    if (st.status === 'unread' && actionAck.get(slot.name) === st.at) return 'empty';
    return st.status === 'idle' ? 'empty' : st.status;
  }
  const { target, session } = slot;
  if (!target) return null;
  if (!target.hasClaude) return 'empty';
  if (!session) return 'idle';
  if (session.status === 'unread' && focusAck.get(session.id) === session.updated) return 'idle';
  return session.status;
}

/**
 * Whole-device wash in the focused session's status color: ambient ring plus
 * key backlight. Working animates (snake), everything else sits solid -- the
 * same distinction the Codex app draws for its selected thread.
 */
function glowFor(status) {
  const off = { effect: FX.off, brightness: 0, speed: 0, magic: 0, color: 0 };
  const style = status && status !== 'empty' ? styleFor(status) : null;
  if (!config.glow || !style) return { keys: off, ambient: off };
  // glowStatuses lets the wash be reserved for states worth a whole-keyboard
  // announcement; null means every status glows.
  if (config.glowStatuses && !config.glowStatuses.includes(status)) return { keys: off, ambient: off };
  const side = {
    effect: status === 'working' ? FX.snake : FX.solid,
    brightness: Math.max(0, Math.min(1, config.glowBrightness * style.scale)),
    speed: status === 'working' ? 0.4 : 0,
    magic: 0,
    color: style.color,
  };
  return { keys: side, ambient: side };
}

async function paint() {
  // One RPC in flight at a time -- but a change that lands mid-write used to be
  // dropped and wait for the next tick, which is what made a press feel late.
  // Remembering it instead means the write that's running is followed straight
  // away by one carrying the newer state.
  if (dev.writing) { dev.paintPending = true; return; }
  const assigned = assignSlots();

  // The joystick borrows the whole agent row while it matters: a charge in
  // progress draws as a bar filling left to right, and a running game turns
  // the row rainbow. Session state comes back the moment either ends.
  const overlay = joyOverlay();

  // Only the agent row (0-5) has per-key LEDs; ACT keys act without lighting.
  const threads = overlay || assigned.filter(slot => slot.slotId <= 5).map(slot => {
    const { slotId } = slot;
    if (slot.kind === 'tmux' && !slot.target) return OFF(slotId);   // no pane there

    const status = statusOf(slot);
    const style = styleFor(status) || styleFor('empty');
    if (!style) return OFF(slotId);

    // Dimming marks "not where you are", which only means something next to a
    // lit session key. An empty pane is already dim; dimming it again would
    // take it to invisible. Action keys are status-driven, never dimmed.
    const dim = config.highlightActive && slot.kind === 'tmux'
      && !slot.target.active && status !== 'empty'
      ? config.inactiveDim : 1;
    return {
      id: slotId,
      color: style.color,
      brightness: Math.max(0, Math.min(1, config.brightness * style.scale * dim)),
      effect: style.effect,
      speed: style.speed,
      syncKeysLighting: false,
      syncAmbientLighting: false,
    };
  });

  const activeSlot = assigned.find(s => s.kind === 'tmux' && s.target && s.target.active);
  const glow = glowFor(activeSlot ? statusOf(activeSlot) : null);
  const glowOff = glow.keys.brightness === 0 && glow.ambient.brightness === 0;

  const allOff = threads.every(t => t.brightness === 0) && glowOff;
  // Nothing to show: paint off once, then stay quiet so the app owns the keys
  // and the device isn't kept awake for nothing.
  if (allOff && dev.lastPaintedOff) return;

  dev.writing = true;
  try {
    // While the game runs the daemon goes RADIO-QUIET: on Bluetooth, every
    // lighting RPC competes with the joystick's input notifications for the
    // same connection's airtime, so re-asserting a rainbow twice a second was
    // taxing the control stream to repaint an effect that hadn't changed. Real
    // changes still go out once; reasserts wait until the game ends. The
    // ChatGPT app might stomp the rainbow meanwhile -- cosmetic, and cheap at
    // the price.
    const inGame = !!joy.game;

    // The glow is a separate RPC, and only worth resending when it changes or
    // has gone stale enough that an app repaint could have replaced it.
    const glowKey = JSON.stringify(glow);
    const glowChanged = glowKey !== dev.lastGlowKey;
    if (glowChanged || (!inGame && Date.now() - dev.lastGlowAt > config.glowReassertMs)) {
      if (await dev.api.sendLightingConfig(glow)) {
        if (glowChanged) {
          const status = activeSlot ? statusOf(activeSlot) : null;
          log(glowOff ? 'glow -> off' :
            `glow -> ${status} #${glow.keys.color.toString(16).padStart(6, '0')}` +
            ` (${activeSlot.target.id})`);
        }
        dev.lastGlowKey = glowKey;
        dev.lastGlowAt = Date.now();
      }
    }

    // Same treatment as the glow: resend when it changes, or when it's stale
    // enough that an app repaint could have replaced it. Writing an identical
    // payload four times a second kept the link busy for nothing, so a real
    // change had to queue behind traffic that said the same thing.
    const threadsKey = JSON.stringify(threads);
    const threadsChanged = threadsKey !== dev.lastThreadsKey;
    if (!threadsChanged && (inGame || Date.now() - dev.lastThreadsAt < config.threadsReassertMs)) return;

    const ok = await dev.api.sendThreadsLighting(threads);
    if (ok) {
      dev.writeFailures = 0;
      dev.lastPaintedOff = allOff;
      dev.lastThreadsKey = threadsKey;
      dev.lastThreadsAt = Date.now();
    } else {
      // Single failures are routine: our RPC traffic interleaves with the
      // app's on the same interface, so a response occasionally goes missing.
      // Only a sustained run of them means the link is actually gone.
      dev.writeFailures += 1;
      if (dev.writeFailures >= WRITE_FAILURE_LIMIT) {
        log(`${dev.writeFailures} consecutive write failures; reconnecting`);
        dev.writeFailures = 0;
        await teardown();
      }
    }
  } catch (e) {
    log('write failed:', e.message);
    await teardown();
  } finally {
    dev.writing = false;
    if (dev.paintPending && dev.connected) { dev.paintPending = false; setImmediate(paint); }
    else dev.paintPending = false;
  }
}

/**
 * Repaint now rather than on the next tick.
 *
 * Everything the lights say about tmux -- which key is bright, which pane is
 * zoomed, which session just went quiet -- is known at the moment it changes,
 * either because this daemon caused it or because a hook wrote it down. Waiting
 * out the tick for something already known is the difference between lights
 * that track the keyboard and lights that trail it.
 *
 * `rescan` is for changes that can add or remove a Claude session, where the
 * pane list alone isn't enough to tell the truth.
 */
let nudgePending = false;
let lastNudgeAt = 0;

function nudge({ rescan = false } = {}) {
  targets.at = 0;                       // re-enumerate rather than serve the cache
  if (rescan) claudeScan.at = 0;
  if (nudgePending) return;
  nudgePending = true;
  // A busy session writes state.json in bursts, and each write would otherwise
  // buy its own tmux enumeration. The first nudge of a burst is still prompt;
  // the rest of the burst is spent inside one wait.
  const wait = Math.max(config.nudgeMs, config.nudgeFloorMs - (Date.now() - lastNudgeAt));
  setTimeout(() => {
    nudgePending = false;
    lastNudgeAt = Date.now();
    tick();
  }, wait).unref();
}

// ---------------------------------------------------------------- main loop

let stopping = false;
let permissionWarned = false;

/**
 * "cannot open device" while the device is plainly enumerable means macOS Input
 * Monitoring, not a device problem. Said once, rather than filling the log with
 * identical stack traces.
 */
function warnPermission() {
  if (permissionWarned) return;
  permissionWarned = true;
  log('cannot open the Micro -- grant Input Monitoring to ' +
      path.join(HERE, 'ClaudeMicro.app') +
      ' (System Settings > Privacy & Security > Input Monitoring), then: ' +
      'launchctl kickstart -k gui/$UID/com.vpid.claude-micro');
}

async function tick() {
  if (stopping) return;
  try {
    joyTick();                                        // drop a stalled charge
    await refreshTargets();                           // cheap and cached; the ps scan isn't awaited
    if (!dev.connected) {
      dev.lastPaintedOff = false;
      // Paint straight after a successful reconnect rather than waiting out
      // another tick, so a device that comes back comes back already lit.
      if (await connect()) await paint();
      return;
    }
    await paint();
  } catch (e) {
    if (/cannot open device/i.test(e.message || '')) warnPermission();
    else log('tick error:', e.stack || e.message);
    await teardown();
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: clearing slots and exiting`);
  endGame(signal);
  try { if (joy.server) joy.server.close(); } catch {}
  // Clearing the lights is best-effort: each RPC can block for the kit's 10s
  // timeout if the device has gone away, and a daemon that won't die blocks its
  // own replacement from claiming the device.
  setTimeout(() => process.exit(0), 2000).unref();
  try {
    if (dev.connected && dev.api) {
      const off = { effect: FX.off, brightness: 0, speed: 0, magic: 0, color: 0 };
      await dev.api.sendLightingConfig({ keys: off, ambient: off });
      await dev.api.sendThreadsLighting(ownedSlotIds().map(OFF));
    }
  } catch {}
  await teardown();
  try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

/**
 * Only one daemon may hold the device. A second instance fights the first for
 * the same RPC channel, which shows up as write failures and duplicated key
 * presses rather than as anything obviously wrong.
 */
function claimSingleInstance() {
  try {
    const prev = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (prev && prev !== process.pid) {
      try {
        process.kill(prev, 0);         // throws unless that pid is alive
        log(`another daemon is already running (pid ${prev}); exiting`);
        process.exit(0);
      } catch {}                       // stale pidfile: fall through and claim it
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function main() {
  rotateLog();
  loadConfig();
  claimSingleInstance();
  log(`claude-micro starting: target=${config.target} reassert=${config.reassertMs}ms\n` +
      `  keys: ${keyEntries().map(e => `${e.name}=${e.action}` +
        (e.action === 'tmux' ? `[${e.index}]` : '')).join(' ') || '(none)'}`);

  /**
   * The directory is watched rather than the two files in it. A watch on a file
   * follows the inode, so anything that saves by writing a new file and renaming
   * it over the old one -- an editor, a script, `hook.py`'s atomic write --
   * leaves the watch pointing at a file nobody will touch again, and the reload
   * silently stops working until the next restart.
   *
   * Hook state is the news the daemon can't see coming, and the news worth
   * showing fastest: a turn finishing is exactly when you look at the keys.
   * Watching for it turns the tick into a fallback rather than the thing that
   * decides how late a status is.
   */
  try {
    fs.watch(HERE, { persistent: false }, (_event, name) => {
      if (name === path.basename(CONFIG_FILE)) {
        loadConfig();
        log(`config reloaded: ${keyEntries().map(e => `${e.name}=${e.action}`).join(' ')}` +
            `${config.knobs.left.key || config.knobs.left.cw ? ' knob=on' : ''}`);
        nudge({ rescan: true });
      } else if (name === path.basename(STATE_FILE)) {
        nudge({ rescan: true });
      }
    });
  } catch (e) { log('cannot watch the config directory; falling back to the tick:', e.message); }

  setInterval(tick, config.reassertMs);
  tick();

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));
  process.on('uncaughtException', e => log('uncaught:', e.stack || e.message));
  process.on('unhandledRejection', e => log('unhandled:', (e && e.stack) || String(e)));
}

main();
