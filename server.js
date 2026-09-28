'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const WORLD = require('./public/world.js');
const { Match } = require('./public/haxball.js');

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
const HAX = WORLD.HAX;
const RECONNECT_GRACE = 15000; // kopan oyuncunun geri dönmesi için süre (ms)
const players = new Map(); // id -> oyuncu
const scores = {}; // id -> atılan gol
let chatLog = []; // son mesajlar (yeni gelenler de görsün)

// ---------- Yönetici ----------
// Şifre koda değil ortam değişkenine konur (Cloud Run ayarı). Tanımlı değilse yönetici girişi kapalıdır.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Tarayıcıda saklanan anahtar şifreden türetilir: sunucu yeniden başlasa da geçerli kalır, şifre değişirse geçersizleşir
const adminKey = ADMIN_PASSWORD
  ? crypto.createHmac('sha256', ADMIN_PASSWORD).update('imlec-kampi-yonetici').digest('hex')
  : null;
const mutes = new Map(); // oyuncu anahtarı (token) ya da id -> susturma bitişi (ms, Infinity = kalıcı)
let adminFails = []; // tüm sitedeki başarısız şifre denemeleri (kaba kuvvete karşı)

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function muteKey(p) {
  return p.token || 'id:' + p.id;
}

function mutedUntil(p) {
  const until = mutes.get(muteKey(p));
  if (!until) return 0;
  if (until !== Infinity && until < Date.now()) {
    mutes.delete(muteKey(p));
    return 0;
  }
  return until;
}

// İsimle oyuncu bul: tam eşleşme, yoksa tek bir önek eşleşmesi
function findPlayer(name) {
  const q = String(name || '').toLocaleLowerCase('tr');
  if (!q) return null;
  const live = [...players.values()].filter((p) => p.ws);
  const exact = live.filter((p) => p.name.toLocaleLowerCase('tr') === q);
  if (exact.length === 1) return exact[0];
  const pre = live.filter((p) => p.name.toLocaleLowerCase('tr').startsWith(q));
  return pre.length === 1 ? pre[0] : null;
}

// Moderasyon işlemleri; sonuç metni yöneticiye bildirilir
function moderate(admin, action, target, minutes) {
  if (['mute', 'unmute', 'kick', 'spec'].includes(action)) {
    if (!target) return 'Oyuncu bulunamadı (isim tam ya da tek anlamlı olmalı).';
    if (target === admin) return 'Kendine uygulayamazsın.';
  }
  switch (action) {
    case 'mute': {
      const m = Number(minutes);
      const until = m > 0 ? Date.now() + Math.min(m, 1440) * 60000 : Infinity;
      mutes.set(muteKey(target), until);
      const len = until === Infinity ? 'kalıcı olarak' : `${Math.round(Math.min(m, 1440))} dakika`;
      notice(target, `Yönetici seni ${len} susturdu.`);
      broadcast({ t: 'notice', text: `${target.name} ${len} susturuldu.` });
      broadcastMuted();
      return null;
    }
    case 'unmute':
      mutes.delete(muteKey(target));
      notice(target, 'Susturman kaldırıldı.');
      broadcastMuted();
      return `${target.name} artık konuşabilir.`;
    case 'kick':
      // Tek seferlik: bağlantı kesilir, kişi sayfayı yenileyip yeniden girebilir
      send(target.ws, { t: 'kicked' });
      broadcast({ t: 'notice', text: `${target.name} yönetici tarafından atıldı.` }, target.id);
      removePlayer(target);
      try { target.ws.close(4001, 'atildi'); } catch {}
      return null;
    case 'spec':
      if (!target.team) return `${target.name} zaten bir takımda değil.`;
      setTeam(target, null);
      notice(target, 'Yönetici seni izleyiciye aldı.');
      return `${target.name} izleyiciye alındı.`;
    case 'stop':
      if (!match) return 'Şu an maç yok.';
      broadcast({ t: 'notice', text: 'Yönetici maçı bitirdi.' });
      stopMatch();
      return null;
    case 'start':
      if (match) return 'Maç zaten sürüyor.';
      if (!teamIds('red').length || !teamIds('blue').length) return 'Her takımda en az 1 oyuncu olmalı.';
      startMatch();
      return null;
    case 'clearchat':
      chatLog = [];
      broadcast({ t: 'clearChat' });
      broadcast({ t: 'notice', text: 'Yönetici sohbeti temizledi.' });
      return null;
  }
  return 'Bilinmeyen işlem.';
}

// Susturulmuş oyuncular listesi (sadece yöneticiler için)
function broadcastMuted() {
  const ids = [...players.values()].filter((p) => p.ws && mutedUntil(p)).map((p) => p.id);
  for (const p of players.values()) if (p.admin) send(p.ws, { t: 'muted', ids });
}

// Sohbet komutları: /sustur isim [dk], /coz isim, /at isim, /izleyici isim, /bitir, /baslat, /temizle
function chatCommand(me, text) {
  const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
  const c = (cmd || '').toLocaleLowerCase('tr');
  if (!me.admin) {
    notice(me, 'Komutlar sadece yönetici içindir.');
    return;
  }
  let action, target = null, minutes = 0;
  const map = { sustur: 'mute', coz: 'unmute', çöz: 'unmute', at: 'kick', izleyici: 'spec', bitir: 'stop', baslat: 'start', başlat: 'start', temizle: 'clearchat' };
  action = map[c];
  if (!action) {
    notice(me, 'Komutlar: /sustur isim [dk] · /coz isim · /at isim · /izleyici isim · /bitir · /baslat · /temizle');
    return;
  }
  if (['mute', 'unmute', 'kick', 'spec'].includes(action)) {
    // İsim birden çok kelime olabilir; susturmada son argüman sayıysa süredir
    let nameArgs = args;
    if (action === 'mute' && args.length > 1 && /^\d+$/.test(args[args.length - 1])) {
      minutes = +args[args.length - 1];
      nameArgs = args.slice(0, -1);
    }
    target = findPlayer(nameArgs.join(' '));
  }
  const res = moderate(me, action, target, minutes);
  if (res) notice(me, res);
}
let nextId = 1;
let match = null; // yürüyen HaxBall maçı
let matchStartedAt = 0;
let lastResult = null; // son biten maç

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) if (p.id !== exceptId) send(p.ws, data);
}

function notice(p, text) {
  send(p.ws, { t: 'notice', text });
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, afk: !!p.afk, typing: !!p.typing, admin: !!p.admin };
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

// Basit hız sınırı: pencere içinde en fazla n olay
function allow(p, key, n, windowMs) {
  const now = Date.now();
  const arr = (p.rate[key] = (p.rate[key] || []).filter((t) => now - t < windowMs));
  if (arr.length >= n) return false;
  arr.push(now);
  return true;
}

function teamIds(team) {
  const ids = [];
  for (const p of players.values()) if (p.team === team) ids.push(p.id);
  return ids;
}

function lobbyState() {
  return { t: 'lobby', red: teamIds('red'), blue: teamIds('blue'), running: !!match, last: lastResult };
}

function broadcastLobby() {
  broadcast(lobbyState());
}

// İmleç bir alanın içinde mi (biraz tolerans)
function onPad(p, pad) {
  const m = 30;
  return p.x >= pad.x - m && p.x <= pad.x + pad.w + m && p.y >= pad.y - m && p.y <= pad.y + pad.h + m;
}

function syncCursorToDisc(p) {
  const d = match && match.players.get(p.id);
  if (!d) return;
  const w = WORLD.toWorld(d.x, d.y);
  p.x = w.x;
  p.y = w.y;
}

// Maçtan çıkan oyuncunun imleci sahanın dışına, takım alanının yanına ışınlanır
function teleportOut(p, team) {
  const pad = WORLD.PADS[team] || WORLD.PADS.start;
  p.x = pad.x + pad.w / 2;
  p.y = pad.y + pad.h + 60;
  send(p.ws, { t: 'tp', x: p.x, y: p.y });
}

function startMatch() {
  match = new Match();
  matchStartedAt = Date.now();
  lastResult = null;
  for (const p of players.values()) {
    if (!p.team) continue;
    p.queue = [];
    match.addPlayer(p.id, p.team);
  }
  broadcastLobby();
  broadcastMatch();
}

function stopMatch() {
  if (!match) return;
  for (const p of players.values()) syncCursorToDisc(p);
  match = null;
  broadcastLobby();
}

function setTeam(p, team) {
  const old = p.team;
  if (old === team) return;
  if (team && teamIds(team).length >= HAX.teamMax) {
    notice(p, `${HAX.teams[team].name} takım dolu (en fazla ${HAX.teamMax} kişi).`);
    return;
  }
  if (match && old) {
    match.removePlayer(p.id);
    teleportOut(p, old);
  }
  p.team = team;
  p.queue = [];
  if (match && team) match.addPlayer(p.id, team);
  broadcastLobby();
}

function removePlayer(p) {
  players.delete(p.id);
  delete scores[p.id];
  if (match) match.removePlayer(p.id);
  broadcast({ t: 'leave', id: p.id });
  if (p.team) broadcastLobby();
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
      const token = typeof m.token === 'string' && /^[a-z0-9]{8,40}$/i.test(m.token) ? m.token : null;
      // Kısa kopmadan dönen oyuncu: aynı kimlik, takım ve disk korunur
      let restored = null;
      if (token) {
        for (const p of players.values()) if (p.token === token && !p.ws) restored = p;
      }
      if (restored) {
        me = restored;
        me.ws = ws;
        me.ghostUntil = 0;
        me.queue = [];
        me.afk = me.typing = false;
      } else {
        if (players.size >= MAX_PLAYERS) {
          send(ws, { t: 'full' });
          ws.close();
          return;
        }
        const tokenInUse = token && [...players.values()].some((p) => p.token === token);
        const x = num(m.x) ? clamp(m.x, 0, WORLD.W) : WORLD.SPAWN.x;
        const y = num(m.y) ? clamp(m.y, 0, WORLD.H) : WORLD.SPAWN.y;
        me = {
          id: nextId++, ws, token: tokenInUse ? null : token, x, y, team: null,
          queue: [], ack: 0, ghostUntil: 0, rate: {},
        };
        players.set(me.id, me);
        scores[me.id] = 0;
      }
      me.name = cleanText(m.name, 16) || 'İsimsiz';
      me.color = WORLD.COLORS.includes(m.color) ? m.color : WORLD.COLORS[0];
      me.admin = !!(adminKey && typeof m.adminKey === 'string' && safeEqual(m.adminKey, adminKey));
      send(ws, {
        t: 'welcome',
        id: me.id,
        restored: !!restored,
        players: [...players.values()].filter((p) => p.ws).map(publicPlayer),
        scores,
        chat: chatLog,
        admin: me.admin,
      });
      send(ws, lobbyState());
      if (me.admin) broadcastMuted();
      if (match) send(ws, { t: 'g', ...match.snapshot(ackOf) });
      broadcast({ t: 'join', p: publicPlayer(me) }, me.id); // geri dönende isim/renk değişmiş olabilir
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
      case 'i': {
        // Maç girdisi: her istemci tick'i için bir tane; sunucu her tick'te bir tane uygular
        if (!match || !match.players.has(me.id) || !num(m.s) || !num(m.k)) return;
        me.queue.push([m.s, m.k & 31]);
        me.lastInputAt = Date.now();
        if (me.queue.length > 8) me.queue.splice(0, me.queue.length - 8); // gecikme birikmesin
        break;
      }
      case 'pad': {
        const pad = WORLD.PADS[m.pad];
        if (!pad || !onPad(me, pad)) return;
        if (m.pad === 'red' || m.pad === 'blue') {
          setTeam(me, me.team === m.pad ? null : m.pad); // aynı alana tekrar tıklamak takımdan çıkarır
        } else if (m.pad === 'start') {
          if (match) {
            // Başlamış maçı oyuncular/izleyiciler bitiremez; sadece yönetici (ya da herkes sahadan çıkınca)
            if (!me.admin) return notice(me, 'Maç sürüyor. Sadece yönetici bitirebilir.');
            if (Date.now() - matchStartedAt < 3000) return; // yanlışlıkla çift tıklamaya karşı
            moderate(me, 'stop');
          } else if (!teamIds('red').length || !teamIds('blue').length) {
            notice(me, 'Başlatmak için her takımda en az 1 oyuncu olmalı.');
          } else startMatch();
        }
        break;
      }
      case 'leave': {
        if (me.team) setTeam(me, null);
        break;
      }
      case 'status': {
        // Oyuncu oyunu durdurdu (uzakta) ya da sohbete yazıyor; diğerleri imlecinin üstünde görür
        const afk = !!m.afk, typing = !!m.typing && !afk;
        if (afk === !!me.afk && typing === !!me.typing) return;
        if (!allow(me, 'status', 20, 5000)) return;
        me.afk = afk;
        me.typing = typing;
        broadcast({ t: 'status', id: me.id, afk, typing }, me.id);
        break;
      }
      case 'admin': {
        // Şifreyle yönetici girişi
        if (!adminKey) {
          send(ws, { t: 'adminFail', text: 'Yönetici girişi bu sunucuda kapalı.' });
          return;
        }
        const now = Date.now();
        adminFails = adminFails.filter((t) => now - t < 60000);
        // Kişi başı dakikada 5, sitenin tamamında dakikada 10 yanlış deneme: kısa şifre de tahminle kırılamasın
        if (!allow(me, 'admin', 5, 60000) || adminFails.length >= 10) {
          send(ws, { t: 'adminFail', text: 'Çok fazla deneme yapıldı, bir dakika bekle.' });
          return;
        }
        if (typeof m.pw !== 'string' || !safeEqual(m.pw, ADMIN_PASSWORD)) {
          adminFails.push(now);
          send(ws, { t: 'adminFail', text: 'Şifre yanlış.' });
          return;
        }
        me.admin = true;
        send(ws, { t: 'adminOk', key: adminKey });
        broadcast({ t: 'join', p: publicPlayer(me) }, me.id); // taç herkese görünsün
        broadcastMuted();
        break;
      }
      case 'adminLogout': {
        me.admin = false;
        broadcast({ t: 'join', p: publicPlayer(me) }, me.id);
        break;
      }
      case 'mod': {
        if (!me.admin) return;
        const target = num(m.id) ? players.get(m.id) : null;
        const res = moderate(me, String(m.action || ''), target && target.ws ? target : null, m.minutes);
        if (res) notice(me, res);
        break;
      }
      case 'bye': {
        // Kullanıcı sayfadan ayrılıyor
        removePlayer(me);
        me = null;
        ws.close(1000);
        break;
      }
      case 'chat': {
        const text = cleanText(m.text, WORLD.CHAT_MAX);
        if (!text) return;
        if (text.startsWith('/')) {
          chatCommand(me, text);
          return;
        }
        const mu = mutedUntil(me);
        if (mu) {
          const left = mu === Infinity ? '' : ` (${Math.ceil((mu - Date.now()) / 60000)} dk kaldı)`;
          notice(me, `Susturuldun, mesajın kimseye gitmedi${left}.`);
          return;
        }
        if (!allow(me, 'chat', 4, 4000)) {
          notice(me, 'Çok hızlı yazıyorsun, biraz bekle.');
          return;
        }
        const msg = { t: 'chat', id: me.id, name: me.name, color: me.color, text, ts: Date.now() };
        chatLog.push(msg);
        if (chatLog.length > 40) chatLog.shift();
        broadcast(msg);
        break;
      }
      case 'ping': {
        if (!num(m.x) || !num(m.y) || !allow(me, 'ping', 4, 1000) || mutedUntil(me)) return;
        broadcast({ t: 'ping', id: me.id, x: clamp(m.x, 0, WORLD.W), y: clamp(m.y, 0, WORLD.H) }, me.id);
        break;
      }
      case 'emote': {
        if (WORLD.EMOJI_PALETTE.includes(m.e) && allow(me, 'emote', 4, 1500) && !mutedUntil(me)) {
          broadcast({ t: 'emote', id: me.id, e: m.e }, me.id);
        }
        break;
      }
    }
  });

  ws.on('close', (code) => {
    if (!me || me.ws !== ws || !players.has(me.id)) return;
    // Sayfa kapatıldı/yenilendi (1000/1001): oyuncuyu hemen sil, eski imleç kalmasın
    if (code === 1000 || code === 1001) {
      removePlayer(me);
      return;
    }
    // Beklenmedik kopma (wifi, Cloud Run 60 dk sınırı): kısa süre yerini koru ama imlecini gizle
    me.ws = null;
    me.queue = [];
    me.ghostUntil = Date.now() + RECONNECT_GRACE;
    if (match) match.setInput(me.id, 0);
    broadcast({ t: 'away', id: me.id });
  });
});

// Ölü bağlantıları ve süresi dolan kopuk oyuncuları temizle
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
setInterval(() => {
  const now = Date.now();
  for (const p of [...players.values()]) if (!p.ws && p.ghostUntil && now > p.ghostUntil) removePlayer(p);
}, 1000);

// ---------- Maç döngüsü (60 Hz, otoriter) ----------
function ackOf(id) {
  const p = players.get(id);
  return p ? [p.ack, p.buf || 2] : [0, 2];
}

function broadcastMatch() {
  if (match) broadcast({ t: 'g', ...match.snapshot(ackOf) });
}

// Uyarlamalı girdi tamponu sınırları (adım) ve ölçüm penceresi (ms)
const BUF_MIN = +(process.env.BUF_MIN || 2);
const BUF_MAX = +(process.env.BUF_MAX || 3);
const BUF_WINDOW = 1500;

let endAt = 0;
function step() {
  // Her oyuncu için sıradaki girdiyi uygula; kuyruk boşsa son girdi kısa süre devam eder
  const now = Date.now();
  for (const d of match.players.values()) {
    const p = players.get(d.id);
    if (!p) continue;
    if (!p.ws || now - (p.lastInputAt || 0) > 250) {
      // Bağlantı yok ya da istemci girdi göndermeyi kesti (sekme arka planda): tuşlar bırakılmış sayılır
      match.setInput(d.id, 0);
      p.queue.length = 0;
      continue;
    }
    // Uyarlamalı tampon: ağ dalgalanıp kuyruk boşalırsa bu oyuncu için daha çok girdi biriktirilir
    // (tahmin bozulmasın), ağ sakinleşince tampon küçültülür (gecikme azalsın)
    if (p.buf == null) {
      p.buf = BUF_MIN;
      p.minQ = Infinity;
      p.winAt = now;
      p.starves = [];
    }
    const next = p.queue.shift();
    if (next) {
      p.ack = next[0];
      match.setInput(d.id, next[1]);
    } else {
      // Tek bir gecikme sıçraması tamponu büyütmesin (giriş gecikmesi artmasın); sık tekrarlarsa büyüt
      p.starves = p.starves.filter((t) => now - t < BUF_WINDOW);
      p.starves.push(now);
      if (p.starves.length >= 3) {
        p.buf = Math.min(BUF_MAX, p.buf + 1);
        p.starves = [];
      }
    }
    p.minQ = Math.min(p.minQ, p.queue.length);
    if (now - p.winAt > BUF_WINDOW) {
      if (p.minQ >= 1 && !p.starves.length && p.buf > BUF_MIN) p.buf--;
      p.minQ = Infinity;
      p.winAt = now;
    }
    // Tamponu aşan fazlalık gecikme demektir; atılan girdideki vuruş basışı korunur
    while (p.queue.length > p.buf) {
      const drop = p.queue.shift();
      p.queue[0][1] |= drop[1] & 16;
    }
  }
  const events = match.step();
  for (const ev of events) {
    if (ev.type === 'goal') {
      if (ev.by != null && !ev.own && scores[ev.by] != null) scores[ev.by]++;
      broadcast({ t: 'goal', team: ev.team, by: ev.by, own: ev.own, score: ev.score, scores });
    } else if (ev.type === 'halftime') {
      broadcast({ t: 'halftime' });
    } else if (ev.type === 'end') {
      lastResult = { winner: ev.winner, score: ev.score, reason: ev.reason };
      broadcast({ t: 'end', winner: ev.winner, score: ev.score, reason: ev.reason });
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
  let broadcastDue = false;
  while (match && nextTick <= now) {
    step();
    nextTick += TICK_MS;
    broadcastDue = true; // 60 Hz tam durum
  }
  if (!match) return;
  for (const p of players.values()) syncCursorToDisc(p);
  if (broadcastDue) broadcastMatch();
  if (match.phase === 'ended' && Date.now() >= endAt) stopMatch();
}, 4);

// ---------- İmleç yayını (30 Hz) ----------
setInterval(() => {
  if (players.size === 0) return;
  const p = [];
  for (const pl of players.values()) if (pl.ws) p.push([pl.id, Math.round(pl.x), Math.round(pl.y)]);
  broadcast({ t: 'state', p });
}, 1000 / 30);

server.listen(PORT, () => console.log(`İmleç Kampı ${PORT} portunda çalışıyor`));
