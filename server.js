'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const WORLD = require('./public/world.js');
const { Match } = require('./haxball.js');

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
const scores = {}; // id -> atılan gol
let nextId = 1;
let match = null; // yürüyen HaxBall maçı
let lastResult = null; // son biten maç {winner, score}

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

function lobbyState() {
  const red = [], blue = [];
  for (const p of players.values()) {
    if (p.team === 'red') red.push(p.id);
    else if (p.team === 'blue') blue.push(p.id);
  }
  return { t: 'lobby', red, blue, running: !!match, last: lastResult };
}

function broadcastLobby() {
  broadcast(lobbyState());
}

// İmleç bir alanın içinde mi (biraz tolerans)
function onPad(p, pad) {
  const m = 30;
  return p.x >= pad.x - m && p.x <= pad.x + pad.w + m && p.y >= pad.y - m && p.y <= pad.y + pad.h + m;
}

function startMatch() {
  match = new Match();
  lastResult = null;
  for (const p of players.values()) if (p.team) match.addPlayer(p.id, p.team);
  broadcastLobby();
}

function stopMatch() {
  if (!match) return;
  // Oyuncuların imleçleri disklerin olduğu yerde kalır
  for (const d of match.players.values()) {
    const p = players.get(d.id);
    if (p) {
      const w = WORLD.toWorld(d.x, d.y);
      p.x = w.x;
      p.y = w.y;
    }
  }
  match = null;
  broadcastLobby();
}

function setTeam(p, team) {
  if (p.team === team) team = null; // aynı alana tekrar tıklamak takımdan çıkarır
  if (match && p.team) match.removePlayer(p.id);
  p.team = team;
  if (match && team) match.addPlayer(p.id, team);
  if (match && match.players.size === 0) stopMatch();
  broadcastLobby();
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
      me = { id: nextId++, ws, name, color, x, y, team: null };
      players.set(me.id, me);
      scores[me.id] = 0;
      send(ws, {
        t: 'welcome',
        id: me.id,
        players: [...players.values()].map(publicPlayer),
        scores,
      });
      send(ws, lobbyState());
      if (match) send(ws, { t: 'g', ...match.snapshot() });
      broadcast({ t: 'join', p: publicPlayer(me) }, me.id);
      return;
    }
    if (!me) return;

    switch (m.t) {
      case 'pos': {
        if (!num(m.x) || !num(m.y)) return;
        if (match && match.players.has(me.id)) return; // maçtayken konumu disk belirler
        me.x = clamp(m.x, 0, WORLD.W);
        me.y = clamp(m.y, 0, WORLD.H);
        break;
      }
      case 'input': {
        if (match && num(m.k)) match.setInput(me.id, m.k);
        break;
      }
      case 'pad': {
        const pad = WORLD.PADS[m.pad];
        if (!pad || !onPad(me, pad)) return;
        if (m.pad === 'red' || m.pad === 'blue') setTeam(me, m.pad);
        else if (m.pad === 'start') {
          if (match) stopMatch();
          else if ([...players.values()].some((p) => p.team)) startMatch();
        }
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
    if (match) {
      match.removePlayer(me.id);
      if (match.players.size === 0) stopMatch();
    }
    broadcast({ t: 'leave', id: me.id });
    if (me.team) broadcastLobby();
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

// ---------- Maç döngüsü (60 Hz) ----------
let endAt = 0;
function step() {
  const events = match.step();
  for (const ev of events) {
    if (ev.type === 'goal') {
      if (ev.by != null && !ev.own && scores[ev.by] != null) scores[ev.by]++;
      broadcast({ t: 'goal', team: ev.team, by: ev.by, own: ev.own, score: ev.score, scores });
    } else if (ev.type === 'overtime') {
      broadcast({ t: 'overtime' });
    } else if (ev.type === 'end') {
      lastResult = { winner: ev.winner, score: ev.score };
      broadcast({ t: 'end', winner: ev.winner, score: ev.score });
      endAt = Date.now() + 3000;
    }
  }
}

// Sabit adımlı döngü: setInterval ms'ye yuvarladığı için tick'ler gerçek zamana göre sayılır
const TICK_MS = 1000 / 60;
let nextTick = performance.now();
setInterval(() => {
  const now = performance.now();
  if (!match) {
    nextTick = now;
    return;
  }
  if (now - nextTick > 250) nextTick = now; // uzun duraklamadan sonra yetişmeye çalışma
  let stepped = false;
  while (match && nextTick <= now) {
    step();
    nextTick += TICK_MS;
    stepped = true;
  }
  if (!match || !stepped) return;
  // Maç diskleri imleç konumunu da belirler (mini harita, seyirci görünümü)
  for (const d of match.players.values()) {
    const p = players.get(d.id);
    if (p) {
      const w = WORLD.toWorld(d.x, d.y);
      p.x = w.x;
      p.y = w.y;
    }
  }
  broadcast({ t: 'g', ...match.snapshot() });
  if (match.phase === 'ended' && Date.now() >= endAt) stopMatch();
}, 4);

// ---------- İmleç yayını (30 Hz) ----------
setInterval(() => {
  if (players.size === 0) return;
  const p = [];
  for (const pl of players.values()) p.push([pl.id, Math.round(pl.x), Math.round(pl.y)]);
  broadcast({ t: 'state', p });
}, 1000 / 30);

server.listen(PORT, () => console.log(`İmleç Kampı ${PORT} portunda çalışıyor`));
