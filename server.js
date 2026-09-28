'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const WORLD = require('./public/world.js');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 12;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- HTTP (statik dosyalar) ----------
const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bulunamadı');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- Oyun durumu ----------
const players = new Map(); // id -> oyuncu
const scores = {}; // id -> gol
let nextId = 1;

const F = WORLD.FIELD;
const R = WORLD.BALL_R;
const CURSOR_R = 10;
const ball = { x: F.x + F.w / 2, y: F.y + F.h / 2, vx: 0, vy: 0, lastTouch: null, resetAt: 0 };

function resetBall() {
  ball.x = F.x + F.w / 2;
  ball.y = F.y + F.h / 2;
  ball.vx = ball.vy = 0;
  ball.lastTouch = null;
  ball.resetAt = 0;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) if (p.id !== exceptId) send(p.ws, data);
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y };
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (me) return;
      if (players.size >= MAX_PLAYERS) {
        send(ws, { t: 'full' });
        ws.close();
        return;
      }
      const name = cleanText(m.name, 16) || 'İsimsiz';
      const color = WORLD.COLORS.includes(m.color) ? m.color : WORLD.COLORS[0];
      const x = num(m.x) ? clamp(m.x, 0, WORLD.W) : WORLD.SPAWN.x;
      const y = num(m.y) ? clamp(m.y, 0, WORLD.H) : WORLD.SPAWN.y;
      me = { id: nextId++, ws, name, color, x, y, px: x, py: y, vx: 0, vy: 0, lastPos: Date.now() };
      players.set(me.id, me);
      scores[me.id] = 0;
      send(ws, {
        t: 'welcome',
        id: me.id,
        players: [...players.values()].map(publicPlayer),
        ball: [ball.x, ball.y],
        scores,
      });
      broadcast({ t: 'join', p: publicPlayer(me) }, me.id);
      return;
    }
    if (!me) return;

    switch (m.t) {
      case 'pos': {
        if (!num(m.x) || !num(m.y)) return;
        const now = Date.now();
        const x = clamp(m.x, 0, WORLD.W);
        const y = clamp(m.y, 0, WORLD.H);
        const dt = Math.max(0.016, (now - me.lastPos) / 1000);
        // İmleç hızı ardışık konumlardan (px/sn), biraz yumuşatılmış
        const vx = clamp((x - me.x) / dt, -4000, 4000);
        const vy = clamp((y - me.y) / dt, -4000, 4000);
        me.vx = me.vx * 0.3 + vx * 0.7;
        me.vy = me.vy * 0.3 + vy * 0.7;
        me.x = x;
        me.y = y;
        me.lastPos = now;
        break;
      }
      case 'chat': {
        const text = cleanText(m.text, 80);
        if (text) broadcast({ t: 'chat', id: me.id, text });
        break;
      }
      case 'ping': {
        if (!num(m.x) || !num(m.y)) return;
        broadcast({ t: 'ping', id: me.id, x: clamp(m.x, 0, WORLD.W), y: clamp(m.y, 0, WORLD.H) }, me.id);
        break;
      }
      case 'emote': {
        if (WORLD.EMOTES.includes(m.e)) broadcast({ t: 'emote', id: me.id, e: m.e }, me.id);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!me) return;
    players.delete(me.id);
    delete scores[me.id];
    if (ball.lastTouch === me.id) ball.lastTouch = null;
    broadcast({ t: 'leave', id: me.id });
  });
});

// Ölü bağlantıları temizle
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

// ---------- Top fiziği (60 Hz, otoriter) ----------
const TICK = 1 / 60;
const GOAL_LEFT = F.x;
const GOAL_RIGHT = F.x + F.w;
const Y1 = WORLD.GOAL_Y1;
const Y2 = WORLD.GOAL_Y2;
const BOUNCE = 0.8;

function cursorCollisions() {
  const now = Date.now();
  for (const p of players.values()) {
    // Bir süredir hareket bilgisi gelmediyse imleç duruyor demektir
    if (now - p.lastPos > 120) {
      p.vx *= 0.5;
      p.vy *= 0.5;
    }
    // Önceki tick konumundan şimdiki konuma giden doğru parçası ile çarpışma (topun içinden geçmeyi önler)
    const ax = p.px, ay = p.py, bx = p.x, by = p.y;
    p.px = p.x;
    p.py = p.y;
    const sx = bx - ax, sy = by - ay;
    const len2 = sx * sx + sy * sy;
    let t = len2 > 0 ? ((ball.x - ax) * sx + (ball.y - ay) * sy) / len2 : 0;
    t = clamp(t, 0, 1);
    const cx = ax + sx * t, cy = ay + sy * t;
    let nx = ball.x - cx, ny = ball.y - cy;
    let d = Math.hypot(nx, ny);
    if (d >= R + CURSOR_R) continue;
    if (d < 0.001) {
      const sl = Math.hypot(sx, sy) || 1;
      nx = sx / sl || 1;
      ny = sy / sl;
    } else {
      nx /= d;
      ny /= d;
    }
    // Topu imlecin önüne it
    ball.x = bx + nx * (R + CURSOR_R);
    ball.y = by + ny * (R + CURSOR_R);
    const pn = p.vx * nx + p.vy * ny; // imlecin normal yöndeki hızı
    const bn = ball.vx * nx + ball.vy * ny;
    const target = Math.max(pn * 1.15, 60);
    if (bn < target) {
      ball.vx += (target - bn) * nx;
      ball.vy += (target - bn) * ny;
    }
    // Teğetsel sürtünme: imlecin yan hareketi topa biraz aktarılır
    const tx = -ny, ty = nx;
    const pt = p.vx * tx + p.vy * ty;
    const bt = ball.vx * tx + ball.vy * ty;
    ball.vx += (pt - bt) * 0.2 * tx;
    ball.vy += (pt - bt) * 0.2 * ty;
    ball.lastTouch = p.id;
  }
}

function inMouth(y) {
  return y > Y1 && y < Y2;
}

function wallCollisions() {
  // Üst/alt kenar (kale içindeyken kale direkleri arası)
  const insideGoal = ball.x < GOAL_LEFT || ball.x > GOAL_RIGHT;
  const top = insideGoal ? Y1 + R : F.y + R;
  const bottom = insideGoal ? Y2 - R : F.y + F.h - R;
  if (ball.y < top) {
    ball.y = top;
    ball.vy = Math.abs(ball.vy) * BOUNCE;
  } else if (ball.y > bottom) {
    ball.y = bottom;
    ball.vy = -Math.abs(ball.vy) * BOUNCE;
  }
  // Sol
  if (ball.x - R < GOAL_LEFT && !inMouth(ball.y)) {
    ball.x = GOAL_LEFT + R;
    ball.vx = Math.abs(ball.vx) * BOUNCE;
  }
  if (ball.x < GOAL_LEFT - WORLD.GOAL.depth + R) {
    ball.x = GOAL_LEFT - WORLD.GOAL.depth + R;
    ball.vx = Math.abs(ball.vx) * 0.3;
  }
  // Sağ
  if (ball.x + R > GOAL_RIGHT && !inMouth(ball.y)) {
    ball.x = GOAL_RIGHT - R;
    ball.vx = -Math.abs(ball.vx) * BOUNCE;
  }
  if (ball.x > GOAL_RIGHT + WORLD.GOAL.depth - R) {
    ball.x = GOAL_RIGHT + WORLD.GOAL.depth - R;
    ball.vx = -Math.abs(ball.vx) * 0.3;
  }
}

function checkGoal() {
  if (ball.resetAt) return;
  const scored = ball.x < GOAL_LEFT - R || ball.x > GOAL_RIGHT + R;
  if (!scored) return;
  const by = ball.lastTouch && players.has(ball.lastTouch) ? ball.lastTouch : null;
  if (by) scores[by] = (scores[by] || 0) + 1;
  broadcast({ t: 'goal', by, scores });
  ball.resetAt = Date.now() + 1500;
}

function tick() {
  if (ball.resetAt) {
    if (Date.now() >= ball.resetAt) resetBall();
  } else {
    cursorCollisions();
  }
  const MAX_V = 2200;
  const v = Math.hypot(ball.vx, ball.vy);
  if (v > MAX_V) {
    ball.vx *= MAX_V / v;
    ball.vy *= MAX_V / v;
  }
  ball.x += ball.vx * TICK;
  ball.y += ball.vy * TICK;
  ball.vx *= 0.985;
  ball.vy *= 0.985;
  if (Math.abs(ball.vx) < 1) ball.vx = 0;
  if (Math.abs(ball.vy) < 1) ball.vy = 0;
  wallCollisions();
  checkGoal();
}

setInterval(tick, 1000 / 60);

// ---------- Durum yayını (30 Hz) ----------
setInterval(() => {
  if (players.size === 0) return;
  const p = [];
  for (const pl of players.values()) p.push([pl.id, Math.round(pl.x), Math.round(pl.y)]);
  broadcast({ t: 'state', p, b: [Math.round(ball.x * 10) / 10, Math.round(ball.y * 10) / 10] });
}, 1000 / 30);

server.listen(PORT, () => console.log(`İmleç Kampı ${PORT} portunda çalışıyor`));
