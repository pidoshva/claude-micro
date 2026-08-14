#!/usr/bin/env node
/**
 * micro-drift, terminal edition -- the joystick charge-up game, rendered in
 * ANSI inside a tmux window. An arrow adrift in space, steered by the Micro's
 * joystick (or arrow keys); hit a rock and the run is over and this process
 * exits, which closes the tmux window it lives in.
 *
 * Joystick positions arrive over SSE from the daemon (data: {"a":0..1,"d":0..1},
 * angle as a fraction of a full turn, distance from center). Terminal cells are
 * about twice as tall as wide, so vertical distances are doubled for collision
 * and halved for motion to keep space feeling square.
 */
const http = require('http');

const PORT = Number((process.argv.find(a => a.startsWith('--port')) || '').split('=')[1] ||
                    process.argv[process.argv.indexOf('--port') + 1] || 4477);
const TAU = Math.PI * 2;
const out = process.stdout;

const state = {
  t: 0, over: false, score: 0,
  ship: { x: 40, y: 12, angle: 0.75, speed: 0 },
  stick: { a: 0.75, d: 0 },
  rocks: [], stars: [], sparks: [],
};

// Live diagnostics for "it feels laggy": rendered frame rate and joystick
// packets/second, sampled once a second into the HUD. fps low = terminal
// plumbing; rx low while moving the stick = input rate is the ceiling.
let rxCount = 0, frameCount = 0, statLine = '';
setInterval(() => {
  statLine = `fps ${frameCount} · rx ${rxCount}/s`;
  frameCount = 0; rxCount = 0;
}, 1000).unref();

// ---- joystick over SSE --------------------------------------------------
function subscribe() {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/events' }, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { const p = JSON.parse(line.slice(6)); state.stick = { a: p.a, d: p.d }; rxCount++; } catch {}
      }
    });
    res.on('end', () => setTimeout(subscribe, 500).unref());
  });
  req.on('error', () => setTimeout(subscribe, 1000).unref());
}
subscribe();

// ---- keyboard -----------------------------------------------------------
const held = new Set();
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', b => {
    const s = b.toString('latin1');
    if (s === 'q' || s === '\x03' || s === '\x1b') return crash(true);
    const dir = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left' }[s];
    if (!dir) return;
    held.add(dir);
    setTimeout(() => held.delete(dir), 220);       // terminals send repeats, not keyup
    const dx = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    const dy = (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0);
    if (dx || dy) state.stick = { a: ((Math.atan2(dy, dx) / TAU) + 1) % 1, d: 1 };
  });
  setInterval(() => { if (held.size === 0 && state.stick.d === 1) state.stick.d = 0; }, 120).unref();
}

// ---- world --------------------------------------------------------------
function dims() {
  return { W: out.columns || 80, H: (out.rows || 24) - 1 };   // last row for the HUD
}

function seedStars() {
  const { W, H } = dims();
  state.stars = [];
  for (let i = 0; i < Math.floor(W * H / 40); i++) {
    state.stars.push({ x: Math.random() * W, y: Math.random() * H, z: 0.3 + Math.random() * 0.7 });
  }
}
seedStars();
const { W: w0, H: h0 } = dims();
state.ship.x = w0 / 2; state.ship.y = h0 / 2;

function spawnRock() {
  const { W, H } = dims();
  const r = 1 + Math.floor(Math.random() * 3);
  const side = Math.floor(Math.random() * 4);
  const speed = (7 + Math.random() * 9) * (1 + state.t / 45);
  const pos = [
    { x: -r, y: Math.random() * H }, { x: W + r, y: Math.random() * H },
    { x: Math.random() * W, y: -r }, { x: Math.random() * W, y: H + r },
  ][side];
  const aim = Math.atan2((H / 2 - pos.y) * 2 + (Math.random() - 0.5) * H,
                         W / 2 - pos.x + (Math.random() - 0.5) * W * 0.7);
  state.rocks.push({ ...pos, vx: Math.cos(aim) * speed, vy: Math.sin(aim) * speed / 2, r });
}

// ---- game over ----------------------------------------------------------
let exiting = false;
function crash(quiet) {
  if (state.over) return;
  state.over = true;
  if (!quiet) {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * TAU, v = 4 + Math.random() * 22;
      state.sparks.push({ x: state.ship.x, y: state.ship.y,
                          vx: Math.cos(a) * v, vy: Math.sin(a) * v / 2, life: 0.5 + Math.random() * 0.6 });
    }
  }
  setTimeout(quit, quiet ? 100 : 1600);
}

function quit() {
  if (exiting) return;
  exiting = true;
  out.write('\x1b[?25h\x1b[?1049l');                 // cursor back, main screen back
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/gameover', method: 'POST' },
    () => process.exit(0));
  req.on('error', () => process.exit(0));
  req.end();
  setTimeout(() => process.exit(0), 800).unref();
}
process.on('SIGTERM', quit);
process.on('SIGINT', quit);

// ---- render -------------------------------------------------------------
const SHIP_GLYPHS = ['▶', '◢', '▼', '◣', '◀', '◤', '▲', '◥'];
const C = { dim: 238, gray: 246, purple: 135, orange: 208, white: 255 };

out.write('\x1b[?1049h\x1b[?25l');                   // alternate screen, no cursor

/**
 * Diffed rendering: painting every cell of the window every frame shoved
 * hundreds of KB per second through tmux's parser and the terminal's
 * renderer, and the whole game ran at the speed of that plumbing -- felt as
 * lag. Almost nothing changes between frames (a star crosses a cell every
 * half-second, a rock a few times a second), so only cells that differ from
 * the previous frame are written: one cursor move per changed run, colors
 * re-emitted only when they change. A frame is typically a few hundred bytes.
 */
let prev = [];
let pending = false;                                  // backpressure: skip frames, never queue them

function blit(grid, W, H, hud) {
  let s = '';
  let lastColor = null;
  for (let y = 0; y < H; y++) {
    const row = grid[y], old = prev[y];
    for (let x = 0; x < W; x++) {
      if (old && old[x * 2] === row[x * 2] && old[x * 2 + 1] === row[x * 2 + 1]) continue;
      // start of a changed run: one cursor move, then consecutive cells
      s += `\x1b[${y + 1};${x + 1}H`;
      while (x < W && !(old && old[x * 2] === row[x * 2] && old[x * 2 + 1] === row[x * 2 + 1])) {
        const color = row[x * 2];
        if (color !== lastColor) { s += color ? `\x1b[38;5;${color}m` : '\x1b[39m'; lastColor = color; }
        s += row[x * 2 + 1];
        x++;
      }
    }
  }
  s += `\x1b[${H + 1};1H\x1b[38;5;244m${hud}\x1b[0m\x1b[K`;
  lastColor = null;
  prev = grid;
  if (s.length <= hud.length + 24 && prevHud === hud) return;   // nothing changed
  prevHud = hud;
  pending = !out.write(s);
  if (pending) out.once('drain', () => { pending = false; });
}
let prevHud = '';

let last = Date.now();
const timer = setInterval(() => {
  if (pending) return;                                // terminal still swallowing the last frame
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const { W, H } = dims();
  if (prev.length !== H || (prev[0] && prev[0].length !== W * 2)) prev = [];   // resize: full repaint

  if (!state.over) {
    state.t += dt;
    state.score = Math.floor(state.t * 10);

    // The stick is authoritative and immediate. An eased version of this felt
    // laggy for exactly the reason easing exists: it trades response time for
    // smoothness, and position already integrates continuously between
    // packets, so there was no stutter to smooth in the first place.
    const s = state.ship;
    if (state.stick.d >= 0.3) {
      s.angle = state.stick.a;
      s.speed = Math.min(1, state.stick.d) * 34;
    } else {
      s.speed *= Math.pow(0.02, dt);
    }
    s.x = Math.max(1, Math.min(W - 2, s.x + Math.cos(s.angle * TAU) * s.speed * dt));
    s.y = Math.max(1, Math.min(H - 2, s.y + Math.sin(s.angle * TAU) * s.speed * dt / 2));

    const want = Math.min(12, 3 + Math.floor(state.t / 6));
    if (state.rocks.length < want && Math.random() < 0.09) spawnRock();

    for (const k of state.rocks) {
      k.x += k.vx * dt; k.y += k.vy * dt;
      const d = Math.hypot(k.x - s.x, (k.y - s.y) * 2);
      if (d < k.r + 1.1) crash();
    }
    state.rocks = state.rocks.filter(k => k.x > -8 && k.x < W + 8 && k.y > -6 && k.y < H + 6);
  }

  // paint into a [color, char] cell buffer; blit() writes only what changed
  const grid = [];
  for (let y = 0; y < H; y++) {
    const row = new Array(W * 2);
    for (let x = 0; x < W; x++) { row[x * 2] = 0; row[x * 2 + 1] = ' '; }
    grid.push(row);
  }
  const put = (x, y, color, ch) => {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && x < W && y >= 0 && y < H) { grid[y][x * 2] = color; grid[y][x * 2 + 1] = ch; }
  };

  for (const st of state.stars) {
    st.x -= st.z * 2.4 * dt;
    if (st.x < 0) { st.x = W - 1; st.y = Math.random() * H; }
    put(st.x, st.y, C.dim, st.z > 0.7 ? '·' : '.');
  }
  for (const k of state.rocks) {
    for (let dy = -k.r; dy <= k.r; dy++) {
      for (let dx = -k.r * 2; dx <= k.r * 2; dx++) {
        if ((dx / 2) * (dx / 2) + dy * dy <= k.r * k.r * 0.9) {
          put(k.x + dx, k.y + dy, C.gray, k.r > 1 ? '#' : '@');
        }
      }
    }
  }
  state.sparks = state.sparks.filter(p => (p.life -= dt) > 0);
  for (const p of state.sparks) {
    p.x += p.vx * dt; p.y += p.vy * dt;
    put(p.x, p.y, C.orange, '*+x.'[Math.floor(Math.random() * 4)]);
  }
  if (!state.over) {
    const s = state.ship;
    put(s.x, s.y, C.purple, SHIP_GLYPHS[Math.round(s.angle * 8) % 8]);
    if (s.speed > 4) {
      put(s.x - Math.cos(s.angle * TAU) * 2, s.y - Math.sin(s.angle * TAU), C.orange, '~');
    }
  }
  if (state.over && state.sparks.length === 0) {
    const msg = ' GAME OVER ';
    const sc = ` score ${state.score} `;
    const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
    [...msg].forEach((ch, i) => put(cx - msg.length / 2 + i, cy - 1, C.white, ch));
    [...sc].forEach((ch, i) => put(cx - sc.length / 2 + i, cy + 1, C.gray, ch));
  }

  frameCount++;
  const hud = (` ${state.score}`.padEnd(10) + statLine.padEnd(22) +
    (state.over ? '' : 'joystick / arrows to fly · q quits')).slice(0, W - 1);
  blit(grid, W, H, hud);
}, 16);
