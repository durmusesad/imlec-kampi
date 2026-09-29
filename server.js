'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const WORLD = require('./public/world.js');
const { Match } = require('./public/haxball.js');
const TRACK = require('./public/track.js');
const RC = require('./public/racing.js');

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
      if (target.racer) {
        setRacer(target, false);
        notice(target, 'Yönetici seni yarıştan çıkardı.');
        return `${target.name} yarıştan çıkarıldı.`;
      }
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
    case 'stoprace':
      if (!race) return 'Şu an yarış yok.';
      broadcast({ t: 'notice', text: 'Yönetici yarışı bitirdi.' });
      stopRace();
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
  const map = { sustur: 'mute', coz: 'unmute', çöz: 'unmute', at: 'kick', izleyici: 'spec', bitir: 'stop', baslat: 'start', başlat: 'start', temizle: 'clearchat', yarisbitir: 'stoprace', yarışbitir: 'stoprace' };
  action = map[c];
  if (!action) {
    notice(me, 'Komutlar: /sustur isim [dk] · /coz isim · /at isim · /izleyici isim · /bitir · /baslat · /yarisbitir · /temizle');
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
let race = null; // yürüyen F1 yarışı
let raceStartedAt = 0;
let raceEndAt = 0;
let lastRace = null; // son yarışın sonuçları
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

function racerIds() {
  return [...players.values()].filter((p) => p.racer).sort((a, b) => a.racerAt - b.racerAt).map((p) => p.id);
}

function lobbyState() {
  return {
    t: 'lobby', red: teamIds('red'), blue: teamIds('blue'), running: !!match, last: lastResult,
    racers: racerIds(), raceRunning: !!race, raceLast: lastRace,
  };
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
    chan(p, 'm').queue = [];
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
  if (team && p.racer) {
    if (race && race.cars.has(p.id)) return notice(p, 'Yarıştasın; önce L ile yarıştan çık.');
    p.racer = false;
  }
  if (match && old) {
    match.removePlayer(p.id);
    teleportOut(p, old);
  }
  p.team = team;
  chan(p, 'm').queue = [];
  if (match && team) match.addPlayer(p.id, team);
  broadcastLobby();
}

// ---------- F1 yarışı ----------
function setRacer(p, on) {
  if (on === !!p.racer) return;
  if (on) {
    if (race) return notice(p, 'Yarış sürüyor, bitince katılabilirsin.');
    if (racerIds().length >= RC.MAX_CARS) return notice(p, `Yarış dolu (en fazla ${RC.MAX_CARS} araç).`);
    if (p.team) {
      if (match && match.players.has(p.id)) return notice(p, 'Maçtasın; önce L ile maçtan çık.');
      setTeam(p, null);
    }
    p.racer = true;
    p.racerAt = Date.now();
  } else {
    p.racer = false;
    if (race && race.cars.has(p.id)) {
      race.removeCar(p.id);
      teleportToRacePads(p);
    }
  }
  broadcastLobby();
}

function teleportToRacePads(p) {
  const pad = TRACK.PADS.join;
  p.x = pad.x + pad.w / 2;
  p.y = pad.y + pad.h + 50;
  send(p.ws, { t: 'tp', x: p.x, y: p.y });
}

function syncCursorToCar(p) {
  const c = race && race.cars.get(p.id);
  if (!c) return;
  p.x = c.x;
  p.y = c.y;
}

function startRace() {
  race = new RC.Race();
  race.seed = (Date.now() & 0xffff) + 1;
  raceStartedAt = Date.now();
  lastRace = null;
  racerIds().forEach((id, slot) => {
    const p = players.get(id);
    chan(p, 'r').queue = [];
    race.addCar(id, p.color, slot);
  });
  broadcastLobby();
  broadcastRace();
}

function stopRace() {
  if (!race) return;
  for (const p of players.values()) syncCursorToCar(p);
  race = null;
  broadcastLobby();
}

function broadcastRace() {
  if (!race) return;
  const R = TRACK.REGION, M = 1200;
  const g = { t: 'rg', ...race.snapshot((id) => { const p = players.get(id); const c = p && chan(p, 'r'); return c ? [c.ack, c.buf] : [0, 2]; }) };
  // Yarışanlara ve pistin yakınındakilere saniyede 60, uzaktakilere (mini harita için) saniyede 4
  broadcastFresh(g, (p) => race.cars.has(p.id) || (p.x > R.x - M && p.x < R.x + R.w + M && p.y > R.y - M && p.y < R.y + R.h + M));
}

// Hızlı güncellenen durum mesajları için gönderim:
// - Bağlantısı yetişemeyen oyuncunun gönderim kuyruğu doluysa bu durum atlanır; kuyruk birikip oyun
//   gittikçe eski bilgiyle oynanmasın (donup zıplama olmasın), bir sonraki güncel durum gider.
// - Uzaktaki oyunculara seyrek gönderilir (bant genişliği boşa gitmesin).
const FRESH_MAX_BUFFER = 24 * 1024;
function broadcastFresh(msg, isNear, farEvery = 15) {
  const data = JSON.stringify(msg);
  const far = (msg.n || 0) % farEvery === 0; // uzaktakilere bu adımda gönderilsin mi
  for (const p of players.values()) {
    const ws = p.ws;
    if (!ws || ws.readyState !== 1) continue;
    if (isNear && !isNear(p) && !far) continue;
    if (ws.bufferedAmount > FRESH_MAX_BUFFER) continue;
    ws.send(data);
  }
}

function removePlayer(p) {
  players.delete(p.id);
  delete scores[p.id];
  if (match) match.removePlayer(p.id);
  if (race) race.removeCar(p.id);
  if (p.racer) broadcastLobby();
  broadcast({ t: 'leave', id: p.id });
  if (p.team) broadcastLobby();
}

// ---------- WebSocket ----------
// Sıkıştırma (permessage-deflate): JSON durum mesajları yavaş bağlantıda çok daha az yer kaplar.
// Hızlı sıkıştırma seviyesi seçildi; 12 oyuncu için sunucu yükü önemsiz.
const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  perMessageDeflate: { threshold: 128, zlibDeflateOptions: { level: 1, memLevel: 7 } },
});

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
        for (const k of ['m', 'r']) chan(me, k).queue = [];
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
      if (race) broadcastRace();
      broadcast({ t: 'join', p: publicPlayer(me) }, me.id); // geri dönende isim/renk değişmiş olabilir
      return;
    }
    if (!me) return;

    switch (m.t) {
      case 'pos': {
        if (!num(m.x) || !num(m.y)) return;
        if (match && match.players.has(me.id)) return; // maçtayken konumu disk belirler
        if (race && race.cars.has(me.id)) return; // yarıştayken konumu araç belirler
        me.x = clamp(m.x, 0, WORLD.W);
        me.y = clamp(m.y, 0, WORLD.H);
        break;
      }
      case 'i':
      case 'ri': {
        // Maç/yarış girdisi: her istemci tick'i için bir tane; sunucu her tick'te bir tane uygular
        const isRace = m.t === 'ri';
        if (!num(m.s) || !num(m.k)) return;
        if (isRace ? !(race && race.cars.has(me.id)) : !(match && match.players.has(me.id))) return;
        const c = chan(me, isRace ? 'r' : 'm');
        c.queue.push([m.s, m.k & 31]);
        c.lastInputAt = Date.now();
        if (c.queue.length > 8) c.queue.splice(0, c.queue.length - 8); // gecikme birikmesin
        break;
      }
      case 'rpad': {
        const pad = TRACK.PADS[m.pad];
        if (!pad || !onPad(me, pad) || !allow(me, 'pad', 3, 1000)) return;
        if (m.pad === 'join') setRacer(me, !me.racer);
        else if (m.pad === 'start') {
          if (race) {
            if (!me.admin) return notice(me, 'Yarış sürüyor. Sadece yönetici bitirebilir.');
            if (Date.now() - raceStartedAt < 3000) return;
            moderate(me, 'stoprace');
          } else if (!racerIds().length) notice(me, 'Önce yarışa katılan olmalı.');
          else startRace();
        }
        break;
      }
      case 'pad': {
        const pad = WORLD.PADS[m.pad];
        if (!pad || !onPad(me, pad) || !allow(me, 'pad', 3, 1000)) return; // makroyla seri tıklamaya karşı
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
        if (me.racer) setRacer(me, false);
        else if (me.team) setTeam(me, null);
        break;
      }
      case 'png': {
        // Ping ölçümü: istemcinin gönderdiği zamanı aynen geri yolla
        if (num(m.c) && allow(me, 'png', 4, 2000)) send(ws, { t: 'pong', c: m.c });
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
    for (const k of ['m', 'r']) chan(me, k).queue = [];
    me.ghostUntil = Date.now() + RECONNECT_GRACE;
    if (match) match.setInput(me.id, 0);
    if (race) race.setInput(me.id, 0);
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

// ---------- Oyun döngüsü (60 Hz, otoriter) ----------
// Uyarlamalı girdi tamponu sınırları (adım) ve ölçüm penceresi (ms)
const BUF_MIN = +(process.env.BUF_MIN || 2);
const BUF_MAX = +(process.env.BUF_MAX || 3);
const BUF_WINDOW = 1500;

// Her oyuncunun maç ('m') ve yarış ('r') için ayrı girdi kanalı
function chan(p, name) {
  const k = 'ch_' + name;
  if (!p[k]) p[k] = { queue: [], ack: 0, buf: BUF_MIN, minQ: Infinity, winAt: Date.now(), starves: [], lastInputAt: 0 };
  return p[k];
}

// Sıradaki girdiyi uygula. Uyarlamalı tampon: ağ dalgalanıp kuyruk sık boşalırsa daha çok girdi biriktir
// (tahmin bozulmasın), ağ sakinleşince küçült (gecikme azalsın)
function pullInput(p, c, now, set) {
  if (!p.ws || now - c.lastInputAt > 250) {
    // Bağlantı yok ya da istemci girdi göndermeyi kesti (sekme arka planda): tuşlar bırakılmış sayılır
    set(0);
    c.queue.length = 0;
    return;
  }
  const next = c.queue.shift();
  if (next) {
    c.ack = next[0];
    set(next[1]);
  } else {
    // Tek bir gecikme sıçraması tamponu büyütmesin (giriş gecikmesi artmasın); sık tekrarlarsa büyüt
    c.starves = c.starves.filter((t) => now - t < BUF_WINDOW);
    c.starves.push(now);
    if (c.starves.length >= 3) {
      c.buf = Math.min(BUF_MAX, c.buf + 1);
      c.starves = [];
    }
  }
  c.minQ = Math.min(c.minQ, c.queue.length);
  if (now - c.winAt > BUF_WINDOW) {
    if (c.minQ >= 1 && !c.starves.length && c.buf > BUF_MIN) c.buf--;
    c.minQ = Infinity;
    c.winAt = now;
  }
  // Tamponu aşan fazlalık gecikme demektir; atılan girdideki vuruş basışı korunur
  while (c.queue.length > c.buf) {
    const drop = c.queue.shift();
    c.queue[0][1] |= drop[1] & 16;
  }
}

function ackOf(id) {
  const p = players.get(id);
  const c = p && chan(p, 'm');
  return c ? [c.ack, c.buf] : [0, 2];
}

function broadcastMatch() {
  if (!match) return;
  const F = WORLD.FIELD, M = 1200;
  // Maçtakilere ve sahanın yakınındakilere saniyede 60, uzaktakilere (mini harita için) saniyede 4
  broadcastFresh({ t: 'g', ...match.snapshot(ackOf) },
    (p) => match.players.has(p.id) || (p.x > F.x - M && p.x < F.x + F.w + M && p.y > F.y - M && p.y < F.y + F.h + M));
}

let endAt = 0;
function stepMatch(now) {
  for (const d of match.players.values()) {
    const p = players.get(d.id);
    if (p) pullInput(p, chan(p, 'm'), now, (k) => match.setInput(d.id, k));
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

function stepRace(now) {
  for (const c of race.cars.values()) {
    const p = players.get(c.id);
    if (p) pullInput(p, chan(p, 'r'), now, (k) => race.setInput(c.id, k));
  }
  const events = race.step();
  for (const ev of events) {
    if (ev.type === 'lights') broadcast({ t: 'rlights' });
    else if (ev.type === 'go') broadcast({ t: 'rgo' });
    else if (ev.type === 'lap') broadcast({ t: 'rlap', id: ev.id, lap: ev.lap, time: ev.time });
    else if (ev.type === 'finish') broadcast({ t: 'rfinish', id: ev.id, pos: ev.pos, time: ev.time });
    else if (ev.type === 'end') {
      const names = {};
      for (const r of ev.results) names[r.id] = (players.get(r.id) || {}).name || '?';
      lastRace = { reason: ev.reason, results: ev.results.map((r) => ({ ...r, name: names[r.id] })) };
      broadcast({ t: 'rend', ...lastRace });
      raceEndAt = Date.now() + (ev.reason === 'empty' ? 1000 : 10000);
    }
  }
}

// Sabit adımlı döngü: setInterval ms'ye yuvarladığı için tick'ler gerçek zamana göre sayılır
const TICK_MS = 1000 / 60;
let nextTick = performance.now();
setInterval(() => {
  const now = performance.now();
  if (!match && !race) {
    nextTick = now;
    return;
  }
  if (now - nextTick > 250) nextTick = now; // uzun duraklamadan sonra yetişmeye çalışma
  let stepped = false;
  const wall = Date.now();
  while ((match || race) && nextTick <= now) {
    if (match) stepMatch(wall);
    if (race) stepRace(wall);
    nextTick += TICK_MS;
    stepped = true;
  }
  if (match) {
    for (const p of players.values()) syncCursorToDisc(p);
    if (stepped) broadcastMatch();
    if (match.phase === 'ended' && Date.now() >= endAt) stopMatch();
  }
  if (race) {
    for (const p of players.values()) syncCursorToCar(p);
    if (stepped) broadcastRace();
    if (race.phase === 'ended' && Date.now() >= raceEndAt) stopRace();
  }
}, 4);

// ---------- İmleç yayını (30 Hz) ----------
setInterval(() => {
  if (players.size === 0) return;
  const p = [];
  for (const pl of players.values()) if (pl.ws) p.push([pl.id, Math.round(pl.x), Math.round(pl.y)]);
  broadcastFresh({ t: 'state', p });
}, 1000 / 30);

server.listen(PORT, () => console.log(`İmleç Kampı ${PORT} portunda çalışıyor`));
