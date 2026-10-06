'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const WORLD = require('./public/world.js');
const { Match } = require('./public/haxball.js');
const { VMatch } = require('./public/volleyball.js');
const { HMatch } = require('./public/hockey.js');
const { TMatch } = require('./public/tank.js');
const TRACK = require('./public/track.js');
const RC = require('./public/racing.js');
const SKINS = require('./public/skins.js');
const BOTS = require('./bots.js');
const { Table: BJTable } = require('./blackjack.js');

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

// ---------- Site şifresi ----------
// SITE_PASSWORD tanımlıysa site gizlidir: sayfa, dosyalar (araç modeli dahil) ve oyun bağlantısı şifre ister.
// Tarayıcı şifreyi bir kez sorar (HTTP Basic); doğruysa 30 günlük çerez verilir. Şifre koda değil Cloud Run ayarına yazılır.
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const SITE_TOKEN = SITE_PASSWORD ? crypto.createHmac('sha256', SITE_PASSWORD).update('imlec-kampi-site').digest('hex') : '';
function siteAuth(req) {
  if (!SITE_PASSWORD) return 'open';
  const ck = /(?:^|;\s*)ik_site=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (ck && safeEqual(ck[1], SITE_TOKEN)) return 'cookie';
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
    if (safeEqual(dec.slice(dec.indexOf(':') + 1), SITE_PASSWORD)) return 'basic';
  }
  return null;
}

// ---------- HTTP (statik dosyalar) ----------
const server = http.createServer((req, res) => {
  const auth = siteAuth(req);
  if (!auth) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Imlec Kampi", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bu site gizli. Giriş için şifre gerekli.');
    return;
  }
  if (auth === 'basic') {
    res.setHeader('Set-Cookie', `ik_site=${SITE_TOKEN}; Max-Age=${30 * 86400}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  }
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
      if (target.vteam) {
        setVTeam(target, null);
        notice(target, 'Yönetici seni izleyiciye aldı.');
        return `${target.name} voleybol takımından çıkarıldı.`;
      }
      if (target.tanker) {
        setTanker(target, false);
        notice(target, 'Yönetici seni izleyiciye aldı.');
        return `${target.name} tank oyunundan çıkarıldı.`;
      }
      if (bjSeated(target)) {
        bj.leave(target.id, Date.now());
        notice(target, 'Yönetici seni blackjack masasından kaldırdı.');
        return `${target.name} blackjack masasından kaldırıldı.`;
      }
      if (target.hteam) {
        setHTeam(target, null);
        notice(target, 'Yönetici seni izleyiciye aldı.');
        return `${target.name} hokey takımından çıkarıldı.`;
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
    case 'vstop':
      if (!vmatch) return 'Şu an voleybol maçı yok.';
      broadcast({ t: 'notice', text: 'Yönetici voleybol maçını bitirdi.' });
      stopVMatch();
      return null;
    case 'tstop':
      if (!tmatch) return 'Şu an tank maçı yok.';
      broadcast({ t: 'notice', text: 'Yönetici tank maçını bitirdi.' });
      stopTMatch();
      return null;
    case 'hstop':
      if (!hmatch) return 'Şu an hokey maçı yok.';
      broadcast({ t: 'notice', text: 'Yönetici hokey maçını bitirdi.' });
      stopHMatch();
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
  const map = { sustur: 'mute', coz: 'unmute', çöz: 'unmute', at: 'kick', izleyici: 'spec', bitir: 'stop', baslat: 'start', başlat: 'start', temizle: 'clearchat', yarisbitir: 'stoprace', yarışbitir: 'stoprace', voleybitir: 'vstop', hokeybitir: 'hstop', tankbitir: 'tstop' };
  action = map[c];
  if (!action) {
    notice(me, 'Komutlar: /sustur isim [dk] · /coz isim · /at isim · /izleyici isim · /bitir · /baslat · /yarisbitir · /voleybitir · /hokeybitir · /tankbitir · /temizle');
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
let vmatch = null; // yürüyen voleybol maçı
let vmatchStartedAt = 0;
let vLastResult = null;
let vEndAt = 0;
let tmatch = null; // yürüyen tank maçı
let tmatchStartedAt = 0;
let tLast = null;
let tEndAt = 0;
let hmatch = null; // yürüyen buz hokeyi maçı
let hmatchStartedAt = 0;
let hLastResult = null;
let hEndAt = 0;
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
  return { id: p.id, name: p.name, color: p.color, skin: p.skin, x: p.x, y: p.y, afk: !!p.afk, typing: !!p.typing, admin: !!p.admin, bot: !!p.bot };
}

// ---------- Botlar ----------
// Sunucuda yaşayan sahte oyuncular: bağlantıları yoktur, girdilerini bots.js üretir.
// Tek başına test için: her takım alanının altındaki "+ Bot / − Bot" kutularıyla eklenir.
const BOT_PADS = WORLD.botPadList(TRACK);
let botSeq = 0;
function makeBot(at) {
  const skin = SKINS.LIST[Math.floor(Math.random() * SKINS.LIST.length)].id;
  const p = {
    id: nextId++, ws: null, bot: true, token: null, x: at.x, y: at.y, team: null,
    queue: [], ack: 0, ghostUntil: 0, rate: {}, name: `🤖 Bot ${++botSeq}`, skin, color: SKINS.labelColor(skin),
  };
  players.set(p.id, p);
  scores[p.id] = 0;
  broadcast({ t: 'join', p: publicPlayer(p) });
  return p;
}

function botsIn(g, team) {
  const key = { f: 'team', v: 'vteam', h: 'hteam' }[g];
  return [...players.values()].filter((p) => p.bot && (g === 'r' ? p.racer : g === 't' ? p.tanker : p[key] === team));
}

// Aynı anda sadece tek oyunda bot olabilir. Botlar başka bir oyunda bekliyorsa (maç yoksa) oradan
// silinir; o oyunda maç sürüyorsa ekleme reddedilir.
const GAME_NAMES = { f: 'Futbol', v: 'Voleybol', h: 'Hokey', t: 'Tank', r: 'Yarış', b: 'Blackjack' };
function botGame(p) {
  return p.team ? 'f' : p.vteam ? 'v' : p.hteam ? 'h' : p.tanker ? 't' : p.racer ? 'r' : null;
}
function gameRunning(g) {
  return !!{ f: match, v: vmatch, h: hmatch, t: tmatch, r: race }[g];
}
function claimBots(me, g) {
  const others = [...players.values()].filter((p) => p.bot && botGame(p) && botGame(p) !== g);
  if (!others.length) return true;
  const og = botGame(others[0]);
  if (gameRunning(og)) {
    notice(me, `Botlar şu an ${GAME_NAMES[og]} maçında. Aynı anda sadece tek oyunda bot olabilir.`);
    return false;
  }
  for (const p of others) removePlayer(p);
  notice(me, `${GAME_NAMES[og]} alanındaki botlar kaldırıldı (aynı anda sadece tek oyunda bot olabilir).`);
  return true;
}

function addBot(me, g, team, at) {
  if (!claimBots(me, g)) return;
  if (g === 't') {
    if (tankerIds().length >= TK.maxTanks) return notice(me, `Tank oyunu dolu (en fazla ${TK.maxTanks} tank).`);
    setTanker(makeBot(at), true);
    return;
  }
  if (g === 'r') {
    if (race) return notice(me, 'Yarış sürüyor, bitince bot ekleyebilirsin.');
    if (racerIds().length >= RC.MAX_CARS) return notice(me, `Start dolu (en fazla ${RC.MAX_CARS} araç).`);
    setRacer(makeBot(at), true);
    return;
  }
  const ids = g === 'f' ? teamIds(team) : g === 'v' ? vteamIds(team) : hteamIds(team);
  const cfg = g === 'f' ? HAX : g === 'v' ? WORLD.VB : WORLD.HK;
  if (ids.length >= cfg.teamMax) return notice(me, `${cfg.teams[team].name} takım dolu (en fazla ${cfg.teamMax} kişi).`);
  const b = makeBot(at);
  if (g === 'f') setTeam(b, team);
  else if (g === 'v') setVTeam(b, team);
  else setHTeam(b, team);
}

function removeBot(me, g, team) {
  const list = botsIn(g, team);
  if (!list.length) return notice(me, 'Burada kaldırılacak bot yok.');
  removePlayer(list[list.length - 1]);
}

// Sitede gerçek oyuncu kalmayınca botlar da gider (kimsenin izlemediği maç sonsuza kadar sürmesin)
// Maçta gerçek oyuncu vardı ve hepsi çıktıysa maç biter (sadece botları izlemek için başlatılan maç sürer)
function stepOrAbandon(game) {
  const human = [...game.players.keys()].some((id) => { const p = players.get(id); return p && !p.bot; });
  if (human) game.hadHuman = true;
  if (!game.hadHuman || human || game.phase === 'ended') return game.step();
  const ev = [];
  game.finish(ev, 'empty');
  return ev;
}

function removeAllBotsIfAlone() {
  if ([...players.values()].some((p) => !p.bot)) return;
  for (const p of [...players.values()]) if (p.bot) removePlayer(p);
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

function vteamIds(team) {
  const ids = [];
  for (const p of players.values()) if (p.vteam === team) ids.push(p.id);
  return ids;
}

function hteamIds(team) {
  const ids = [];
  for (const p of players.values()) if (p.hteam === team) ids.push(p.id);
  return ids;
}

function tankerIds() {
  return [...players.values()].filter((p) => p.tanker).sort((a, b) => a.tankerAt - b.tankerAt).map((p) => p.id);
}

function racerIds() {
  return [...players.values()].filter((p) => p.racer).sort((a, b) => a.racerAt - b.racerAt).map((p) => p.id);
}

function lobbyState() {
  return {
    t: 'lobby', red: teamIds('red'), blue: teamIds('blue'), running: !!match, last: lastResult,
    racers: racerIds(), raceRunning: !!race, raceLast: lastRace, rmode: race ? race.mode : raceMode,
    vred: vteamIds('red'), vblue: vteamIds('blue'), vRunning: !!vmatch, vLast: vLastResult,
    hred: hteamIds('red'), hblue: hteamIds('blue'), hRunning: !!hmatch, hLast: hLastResult,
    tankers: tankerIds(), tRunning: !!tmatch, tLast,
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
  if (team && p.vteam) {
    if (vmatch && vmatch.players.has(p.id)) return notice(p, 'Voleybol maçındasın; önce L ile maçtan çık.');
    p.vteam = null;
  }
  if (team && p.hteam) {
    if (hmatch && hmatch.players.has(p.id)) return notice(p, 'Hokey maçındasın; önce L ile maçtan çık.');
    p.hteam = null;
  }
  if (team && p.tanker && !leaveTankLobby(p)) return;
  if (match && old) {
    match.removePlayer(p.id);
    teleportOut(p, old);
  }
  if (team && bjSeated(p)) bj.leave(p.id, Date.now());
  p.team = team;
  chan(p, 'm').queue = [];
  if (match && team) match.addPlayer(p.id, team);
  broadcastLobby();
}

// ---------- Plaj voleybolu ----------
const VB = WORLD.VB;
function setVTeam(p, team) {
  const old = p.vteam;
  if (old === team) return;
  if (team && vteamIds(team).length >= VB.teamMax) {
    notice(p, `${VB.teams[team].name} takım dolu (en fazla ${VB.teamMax} kişi).`);
    return;
  }
  if (team && p.team) {
    if (match && match.players.has(p.id)) return notice(p, 'Futbol maçındasın; önce L ile maçtan çık.');
    p.team = null;
    broadcastLobby();
  }
  if (team && p.racer) {
    if (race && race.cars.has(p.id)) return notice(p, 'Yarıştasın; önce L ile yarıştan çık.');
    p.racer = false;
  }
  if (team && p.hteam) {
    if (hmatch && hmatch.players.has(p.id)) return notice(p, 'Hokey maçındasın; önce L ile maçtan çık.');
    p.hteam = null;
  }
  if (team && p.tanker && !leaveTankLobby(p)) return;
  if (vmatch && old) {
    vmatch.removePlayer(p.id);
    teleportOutV(p, old);
  }
  if (team && bjSeated(p)) bj.leave(p.id, Date.now());
  p.vteam = team;
  chan(p, 'v').queue = [];
  if (vmatch && team) vmatch.addPlayer(p.id, team);
  broadcastLobby();
}

function teleportOutV(p, team) {
  const pad = WORLD.VPADS[team] || WORLD.VPADS.start;
  p.x = pad.x + pad.w / 2;
  p.y = pad.y + pad.h + 60;
  send(p.ws, { t: 'tp', x: p.x, y: p.y });
}

function syncCursorToVb(p) {
  const d = vmatch && vmatch.players.get(p.id);
  if (!d) return;
  const w = WORLD.vbToWorld(d.x, d.y);
  p.x = w.x;
  p.y = w.y;
}

function startVMatch() {
  vmatch = new VMatch();
  vmatchStartedAt = Date.now();
  vLastResult = null;
  for (const p of players.values()) {
    if (!p.vteam) continue;
    chan(p, 'v').queue = [];
    vmatch.addPlayer(p.id, p.vteam);
  }
  broadcastLobby();
  broadcastVMatch();
}

function stopVMatch() {
  if (!vmatch) return;
  for (const p of players.values()) syncCursorToVb(p);
  vmatch = null;
  broadcastLobby();
}

function vackOf(id) {
  const p = players.get(id);
  const c = p && chan(p, 'v');
  return c ? [c.ack, c.buf] : [0, 2];
}

function broadcastVMatch() {
  if (!vmatch) return;
  const F = WORLD.VFIELD, M = 1200;
  broadcastFresh({ t: 'vg', ...vmatch.snapshot(vackOf) },
    (p) => vmatch.players.has(p.id) || p.watch === 'v' || (p.x > F.x - M && p.x < F.x + F.w + M && p.y > F.y - M && p.y < F.y + F.h + M));
}

function stepVMatch(now) {
  for (const d of vmatch.players.values()) {
    const p = players.get(d.id);
    if (p && p.bot) {
      const o = BOTS.volley(vmatch, d);
      vmatch.setInput(d.id, o.bits, o.ax, o.ay);
    } else if (p) pullInput(p, chan(p, 'v'), now, (k, e) => vmatch.setInput(d.id, k, e && e[2], e && e[3]));
  }
  for (const ev of stepOrAbandon(vmatch)) {
    if (ev.type === 'point') {
      if (ev.by != null && ev.reason === 'in' && scores[ev.by] != null) scores[ev.by]++;
      broadcast({ t: 'vpoint', team: ev.team, reason: ev.reason, by: ev.by, score: ev.score, scores });
    } else if (ev.type === 'end') {
      vLastResult = { winner: ev.winner, score: ev.score, reason: ev.reason };
      broadcast({ t: 'vend', winner: ev.winner, score: ev.score, reason: ev.reason });
      vEndAt = Date.now() + 3000;
    }
  }
}

// ---------- Buz hokeyi ----------
const HK = WORLD.HK;
function setHTeam(p, team) {
  const old = p.hteam;
  if (old === team) return;
  if (team && hteamIds(team).length >= HK.teamMax) {
    notice(p, `${HK.teams[team].name} takım dolu (en fazla ${HK.teamMax} kişi).`);
    return;
  }
  if (team && p.team) {
    if (match && match.players.has(p.id)) return notice(p, 'Futbol maçındasın; önce L ile maçtan çık.');
    p.team = null;
  }
  if (team && p.vteam) {
    if (vmatch && vmatch.players.has(p.id)) return notice(p, 'Voleybol maçındasın; önce L ile maçtan çık.');
    p.vteam = null;
  }
  if (team && p.racer) {
    if (race && race.cars.has(p.id)) return notice(p, 'Yarıştasın; önce L ile yarıştan çık.');
    p.racer = false;
  }
  if (team && p.tanker && !leaveTankLobby(p)) return;
  if (hmatch && old) {
    hmatch.removePlayer(p.id);
    const pad = WORLD.HPADS[old];
    p.x = pad.x + pad.w / 2;
    p.y = pad.y + pad.h + 60;
    send(p.ws, { t: 'tp', x: p.x, y: p.y });
  }
  if (team && bjSeated(p)) bj.leave(p.id, Date.now());
  p.hteam = team;
  chan(p, 'h').queue = [];
  if (hmatch && team) hmatch.addPlayer(p.id, team);
  broadcastLobby();
}

function syncCursorToHk(p) {
  const d = hmatch && hmatch.players.get(p.id);
  if (!d) return;
  const w = WORLD.hkToWorld(d.x, d.y);
  p.x = w.x;
  p.y = w.y;
}

function startHMatch() {
  hmatch = new HMatch();
  hmatchStartedAt = Date.now();
  hLastResult = null;
  for (const p of players.values()) {
    if (!p.hteam) continue;
    chan(p, 'h').queue = [];
    hmatch.addPlayer(p.id, p.hteam);
  }
  broadcastLobby();
  broadcastHMatch();
}

function stopHMatch() {
  if (!hmatch) return;
  for (const p of players.values()) syncCursorToHk(p);
  hmatch = null;
  broadcastLobby();
}

function hackOf(id) {
  const p = players.get(id);
  const c = p && chan(p, 'h');
  return c ? [c.ack, c.buf] : [0, 2];
}

function broadcastHMatch() {
  if (!hmatch) return;
  const F = WORLD.HFIELD, M = 1200;
  broadcastFresh({ t: 'hg', ...hmatch.snapshot(hackOf) },
    (p) => hmatch.players.has(p.id) || p.watch === 'h' || (p.x > F.x - M && p.x < F.x + F.w + M && p.y > F.y - M && p.y < F.y + F.h + M));
}

function stepHMatch(now) {
  for (const d of hmatch.players.values()) {
    const p = players.get(d.id);
    if (p && p.bot) hmatch.setInput(d.id, BOTS.hockey(hmatch, d));
    else if (p) pullInput(p, chan(p, 'h'), now, (k) => hmatch.setInput(d.id, k));
  }
  for (const ev of stepOrAbandon(hmatch)) {
    if (ev.type === 'goal') {
      if (ev.by != null && !ev.own && scores[ev.by] != null) scores[ev.by]++;
      broadcast({ t: 'hgoal', team: ev.team, by: ev.by, own: ev.own, score: ev.score, scores });
    } else if (ev.type === 'period') {
      broadcast({ t: 'hperiod', period: ev.period });
    } else if (ev.type === 'end') {
      hLastResult = { winner: ev.winner, score: ev.score, reason: ev.reason };
      broadcast({ t: 'hend', winner: ev.winner, score: ev.score, reason: ev.reason });
      hEndAt = Date.now() + 3000;
    }
  }
}

// ---------- Tank ----------
const TK = WORLD.TK;
// Başka oyuna geçerken tank listesinden çık (tank maçında oynuyorsa önce L gerekir)
function leaveTankLobby(p) {
  if (tmatch && tmatch.players.has(p.id)) {
    notice(p, 'Tank maçındasın; önce L ile maçtan çık.');
    return false;
  }
  p.tanker = false;
  return true;
}

function setTanker(p, on) {
  if (on === !!p.tanker) return;
  if (on) {
    if (tankerIds().length >= TK.maxTanks) return notice(p, `Tank oyunu dolu (en fazla ${TK.maxTanks} tank).`);
    const busy = (match && match.players.has(p.id) && 'Futbol') || (vmatch && vmatch.players.has(p.id) && 'Voleybol') ||
      (hmatch && hmatch.players.has(p.id) && 'Hokey') || (race && race.cars.has(p.id) && 'Yarış');
    if (busy) return notice(p, `${busy} oyunundasın; önce L ile çık.`);
    p.team = p.vteam = p.hteam = null;
    p.racer = false;
    if (bjSeated(p)) bj.leave(p.id, Date.now());
    p.tanker = true;
    p.tankerAt = Date.now();
    if (tmatch) {
      tmatch.addPlayer(p.id); // sıradaki turda başlar
      chan(p, 't').queue = [];
    }
  } else {
    p.tanker = false;
    if (tmatch && tmatch.players.has(p.id)) {
      tmatch.removePlayer(p.id);
      const pad = WORLD.TPADS.join;
      p.x = pad.x + pad.w / 2;
      p.y = pad.y + pad.h + 60;
      send(p.ws, { t: 'tp', x: p.x, y: p.y });
    }
  }
  broadcastLobby();
}

function syncCursorToTank(p) {
  const t = tmatch && tmatch.players.get(p.id);
  if (!t || t.x < 0) return;
  p.x = TK.x + t.x;
  p.y = TK.y + t.y;
}

function startTMatch() {
  tmatch = new TMatch();
  tmatchStartedAt = Date.now();
  tLast = null;
  for (const id of tankerIds()) {
    chan(players.get(id), 't').queue = [];
    tmatch.addPlayer(id);
  }
  tmatch.newRound((Math.random() * 0x7fffffff) | 0 || 7);
  broadcastLobby();
  broadcastTMatch();
}

function stopTMatch() {
  if (!tmatch) return;
  for (const p of players.values()) syncCursorToTank(p);
  tmatch = null;
  broadcastLobby();
}

function tackOf(id) {
  const p = players.get(id);
  const c = p && chan(p, 't');
  return c ? [c.ack, c.buf] : [0, 2];
}

// Mayın bilgisi sadece sahibine gider: kurulan mayınlar, kurulum barı ve kalan hak.
// İzleyiciler herkesin gizli halini alır; tank oyuncularına kendi gerçek durumları eklenir
function broadcastTMatch() {
  if (!tmatch) return;
  const F = WORLD.TFIELD, M = 1200;
  const pub = JSON.stringify({ t: 'tg', ...tmatch.snapshot(tackOf, null) });
  const far = tmatch.tick % 15 === 0;
  for (const p of players.values()) {
    const ws = p.ws;
    if (!ws || ws.readyState !== 1 || ws.bufferedAmount > FRESH_MAX_BUFFER) continue;
    const mine = tmatch.players.has(p.id);
    if (!mine && !far && p.watch !== 't' && !(p.x > F.x - M && p.x < F.x + F.w + M && p.y > F.y - M && p.y < F.y + F.h + M)) continue;
    ws.send(mine ? JSON.stringify({ t: 'tg', ...tmatch.snapshot(tackOf, p.id), mn: tmatch.minesOf(p.id) }) : pub);
  }
}

function stepTMatch(now) {
  for (const t of tmatch.players.values()) {
    const p = players.get(t.id);
    if (p && p.bot) tmatch.setInput(t.id, BOTS.tank(tmatch, t));
    else if (p) pullInput(p, chan(p, 't'), now, (k) => tmatch.setInput(t.id, k));
  }
  let events;
  if (tmatch.phase !== 'ended' && tmatch.players.size < 2) {
    events = [];
    tmatch.finish(events, 'few');
  } else events = stepOrAbandon(tmatch);
  for (const ev of events) {
    if (ev.type === 'kill') broadcast({ t: 'tkill', id: ev.id, by: ev.by, how: ev.how, x: ev.x, y: ev.y });
    else if (ev.type === 'boom') broadcast({ t: 'tboom', x: ev.x, y: ev.y });
    else if (ev.type === 'round') {
      if (ev.winner != null && scores[ev.winner] != null) scores[ev.winner]++;
      broadcast({ t: 'tround', winner: ev.winner, round: ev.round, scores });
    } else if (ev.type === 'end') {
      tLast = ev.standings.map((x) => ({ ...x, name: (players.get(x.id) || {}).name || '?' }));
      broadcast({ t: 'tend', reason: ev.reason, standings: tLast });
      tEndAt = Date.now() + 2500;
    }
  }
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
    if (p.vteam) {
      if (vmatch && vmatch.players.has(p.id)) return notice(p, 'Voleybol maçındasın; önce L ile maçtan çık.');
      p.vteam = null;
    }
    if (p.hteam) {
      if (hmatch && hmatch.players.has(p.id)) return notice(p, 'Hokey maçındasın; önce L ile maçtan çık.');
      p.hteam = null;
    }
    if (p.tanker && !leaveTankLobby(p)) return;
    if (bjSeated(p)) bj.leave(p.id, Date.now());
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

// Yarış görünümü yarıştan önce seçilir ve o yarıştaki herkes için aynıdır: '2d' kuş bakışı, '3d' kokpit
let raceMode = '2d';
function startRace() {
  race = new RC.Race();
  race.mode = raceMode;
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
  broadcastFresh(g, (p) => race.cars.has(p.id) || p.watch === 'r' || (p.x > R.x - M && p.x < R.x + R.w + M && p.y > R.y - M && p.y < R.y + R.h + M));
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
  if (p.bot) BOTS.forget(p.id);
  bj.leave(p.id, Date.now());
  if (match) match.removePlayer(p.id);
  if (vmatch) vmatch.removePlayer(p.id);
  if (hmatch) hmatch.removePlayer(p.id);
  if (tmatch) tmatch.removePlayer(p.id);
  if (p.tanker) broadcastLobby();
  if (race) race.removeCar(p.id);
  if (p.hteam) broadcastLobby();
  if (p.vteam) broadcastLobby();
  if (p.racer) broadcastLobby();
  broadcast({ t: 'leave', id: p.id });
  if (p.team) broadcastLobby();
  if (!p.bot) removeAllBotsIfAlone();
}

// ---------- WebSocket ----------
// Sıkıştırma (permessage-deflate): JSON durum mesajları yavaş bağlantıda çok daha az yer kaplar.
// Hızlı sıkıştırma seviyesi seçildi; 12 oyuncu için sunucu yükü önemsiz.
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => !!siteAuth(info.req), // gizli sitede oyun bağlantısı da şifre/çerez ister
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
        for (const k of ['m', 'r', 'v', 'h', 't']) chan(me, k).queue = [];
        me.afk = me.typing = false;
      } else {
        if ([...players.values()].filter((p) => !p.bot).length >= MAX_PLAYERS) {
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
      // Skin: katalogda olmalı; renk (isim etiketi, sohbet, liste) skinden gelir
      me.skin = SKINS.get(m.skin).id;
      me.color = SKINS.labelColor(me.skin);
      me.admin = !!(adminKey && typeof m.adminKey === 'string' && safeEqual(m.adminKey, adminKey));
      send(ws, {
        t: 'welcome',
        id: me.id,
        restored: !!restored,
        players: [...players.values()].filter((p) => p.ws || p.bot).map(publicPlayer),
        scores,
        chat: chatLog,
        admin: me.admin,
      });
      send(ws, lobbyState());
      if (me.admin) broadcastMuted();
      if (match) send(ws, { t: 'g', ...match.snapshot(ackOf) });
      if (vmatch) send(ws, { t: 'vg', ...vmatch.snapshot(vackOf) });
      if (hmatch) send(ws, { t: 'hg', ...hmatch.snapshot(hackOf) });
      if (tmatch) send(ws, { t: 'tg', ...tmatch.snapshot(tackOf, me.id), mn: tmatch.minesOf(me.id) });
      if (race) broadcastRace();
      send(ws, bj.snapshot(Date.now()));
      broadcast({ t: 'join', p: publicPlayer(me) }, me.id); // geri dönende isim/renk değişmiş olabilir
      return;
    }
    if (!me) return;

    switch (m.t) {
      case 'pos': {
        if (!num(m.x) || !num(m.y)) return;
        if (match && match.players.has(me.id)) return; // maçtayken konumu disk belirler
        if (vmatch && vmatch.players.has(me.id)) return;
        if (hmatch && hmatch.players.has(me.id)) return;
        if (tmatch && tmatch.players.has(me.id) && tmatch.players.get(me.id).x >= 0) return;
        if (race && race.cars.has(me.id)) return; // yarıştayken konumu araç belirler
        me.x = clamp(m.x, 0, WORLD.W);
        me.y = clamp(m.y, 0, WORLD.H);
        break;
      }
      case 'i':
      case 'ri':
      case 'hi':
      case 'ti': {
        // Maç/yarış girdisi: her istemci tick'i için bir tane; sunucu her tick'te bir tane uygular
        const name = m.t === 'ri' ? 'r' : m.t === 'hi' ? 'h' : m.t === 'ti' ? 't' : 'm';
        if (!num(m.s) || !num(m.k)) return;
        const game = name === 'r' ? race && race.cars : name === 'h' ? hmatch && hmatch.players
          : name === 't' ? tmatch && tmatch.players : match && match.players;
        if (!(game && game.has(me.id))) return;
        const c = chan(me, name);
        c.queue.push([m.s, m.k & (name === 't' ? 255 : 31)]);
        c.lastInputAt = Date.now();
        if (c.queue.length > 8) c.queue.splice(0, c.queue.length - 8); // gecikme birikmesin
        break;
      }
      case 'vi': {
        // Voleybol girdisi: tuşlar + nişan noktası (voleybol birimi)
        if (!num(m.s) || !num(m.k) || !num(m.ax) || !num(m.ay)) return;
        if (!(vmatch && vmatch.players.has(me.id))) return;
        const c = chan(me, 'v');
        c.queue.push([m.s, m.k & 127, clamp(m.ax, -600, 600), clamp(m.ay, -400, 400)]);
        c.lastInputAt = Date.now();
        if (c.queue.length > 8) c.queue.splice(0, c.queue.length - 8);
        break;
      }
      case 'vpad': {
        const pad = WORLD.VPADS[m.pad];
        if (!pad || !onPad(me, pad) || !allow(me, 'pad', 3, 1000)) return;
        if (m.pad === 'red' || m.pad === 'blue') setVTeam(me, me.vteam === m.pad ? null : m.pad);
        else if (m.pad === 'start') {
          if (vmatch) {
            if (!me.admin) return notice(me, 'Voleybol maçı sürüyor. Sadece yönetici bitirebilir.');
            if (Date.now() - vmatchStartedAt < 3000) return;
            moderate(me, 'vstop');
          } else if (!vteamIds('red').length || !vteamIds('blue').length) {
            notice(me, 'Başlatmak için her takımda en az 1 oyuncu olmalı.');
          } else startVMatch();
        }
        break;
      }
      case 'tpad': {
        const pad = WORLD.TPADS[m.pad];
        if (!pad || !onPad(me, pad) || !allow(me, 'pad', 3, 1000)) return;
        if (m.pad === 'join') setTanker(me, !me.tanker);
        else if (m.pad === 'start') {
          if (tmatch) {
            if (!me.admin) return notice(me, 'Tank maçı sürüyor. Sadece yönetici bitirebilir.');
            if (Date.now() - tmatchStartedAt < 3000) return;
            moderate(me, 'tstop');
          } else if (tankerIds().length < 2) notice(me, 'Başlatmak için en az 2 tank gerekli (bot da olur).');
          else startTMatch();
        }
        break;
      }
      case 'hpad': {
        const pad = WORLD.HPADS[m.pad];
        if (!pad || !onPad(me, pad) || !allow(me, 'pad', 3, 1000)) return;
        if (m.pad === 'red' || m.pad === 'blue') setHTeam(me, me.hteam === m.pad ? null : m.pad);
        else if (m.pad === 'start') {
          if (hmatch) {
            if (!me.admin) return notice(me, 'Hokey maçı sürüyor. Sadece yönetici bitirebilir.');
            if (Date.now() - hmatchStartedAt < 3000) return;
            moderate(me, 'hstop');
          } else if (!hteamIds('red').length || !hteamIds('blue').length) {
            notice(me, 'Başlatmak için her takımda en az 1 oyuncu olmalı.');
          } else startHMatch();
        }
        break;
      }
      case 'bot': {
        const bp = Number.isInteger(m.i) ? BOT_PADS[m.i] : null;
        if (!bp || !onPad(me, bp.r) || !allow(me, 'bot', 5, 1000)) return;
        const at = { x: bp.r.x + bp.r.w / 2, y: bp.r.y + bp.r.h + 50 };
        if (bp.op === 'add') addBot(me, bp.g, bp.team, at);
        else if (bp.op === 'del') removeBot(me, bp.g, bp.team);
        else if (bp.op === 'fill') {
          if (bp.g === 'r' && race) return notice(me, 'Yarış sürüyor, bitince bot ekleyebilirsin.');
          if (!claimBots(me, bp.g)) return;
          if (bp.g === 't') while (tankerIds().length < TK.maxTanks) setTanker(makeBot(at), true);
          else while (racerIds().length < RC.MAX_CARS) setRacer(makeBot(at), true);
        }
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
        } else if (m.pad === 'mode') {
          if (race) return notice(me, 'Yarış sürüyor; görünüm yarıştan önce seçilir.');
          raceMode = raceMode === '3d' ? '2d' : '3d';
          broadcastLobby();
          broadcast({ t: 'notice', text: `🏁 Yarış görünümü: ${raceMode === '3d' ? '3D kokpit' : '2D kuş bakışı'} (bütün pilotlar için)` });
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
        if (me.tanker) setTanker(me, false);
        else if (me.racer) setRacer(me, false);
        else if (me.vteam) setVTeam(me, null);
        else if (me.hteam) setHTeam(me, null);
        else if (me.team) setTeam(me, null);
        else if (bjSeated(me)) bj.leave(me.id, Date.now());
        break;
      }
      case 'watch': {
        // İzleyici modu: oyunda olmayan oyuncu bir maçı izliyor; o maçın durumu ona sık gönderilir
        me.watch = GAME_NAMES[m.g] ? m.g : null;
        break;
      }
      case 'bpad': {
        const pad = WORLD.BJPADS[m.pad];
        if (!pad || !onPad(me, pad) || !allow(me, 'pad', 3, 1000)) return;
        if (/^s\d$/.test(m.pad)) {
          const i = +m.pad[1];
          if (bj.seatOf(me.id) === i) bj.leave(me.id, Date.now());
          else bjSit(me, i);
        } else if (m.pad === 'deal') {
          if (!bjSeated(me)) notice(me, 'Önce bir koltuğa otur.');
          else if (!bj.canStart()) notice(me, 'El sürüyor; bitince Dağıt ile yenisini başlatabilirsin.');
          else bj.start(Date.now());
        } else {
          // Koltuk düğmesi (hit0 / stand3 …): sadece kendi koltuğunun düğmesi geçerli
          const [, a, n] = /^(hit|stand)(\d)$/.exec(m.pad);
          if (bj.seatOf(me.id) === +n) bjAct(me, a);
        }
        break;
      }
      case 'bj': {
        // Klavyeden hamle (Space/W kart çek, S dur); koltukta olmak yeter
        if ((m.a === 'hit' || m.a === 'stand') && allow(me, 'bj', 6, 1000)) bjAct(me, m.a);
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
    for (const k of ['m', 'r', 'v', 'h', 't']) chan(me, k).queue = [];
    me.ghostUntil = Date.now() + RECONNECT_GRACE;
    if (match) match.setInput(me.id, 0);
    if (vmatch) vmatch.setInput(me.id, 0);
    if (hmatch) hmatch.setInput(me.id, 0);
    if (tmatch) tmatch.setInput(me.id, 0);
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
    set(next[1], next);
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
    c.queue[0][1] |= drop[1] & 240; // atılan girdideki vuruş/smaç/balıklama/mayın basışı korunur
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
    (p) => match.players.has(p.id) || p.watch === 'f' || (p.x > F.x - M && p.x < F.x + F.w + M && p.y > F.y - M && p.y < F.y + F.h + M));
}

let endAt = 0;
function stepMatch(now) {
  for (const d of match.players.values()) {
    const p = players.get(d.id);
    if (p && p.bot) match.setInput(d.id, BOTS.football(match, d));
    else if (p) pullInput(p, chan(p, 'm'), now, (k) => match.setInput(d.id, k));
  }
  const events = stepOrAbandon(match);
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
    if (p && p.bot) race.setInput(c.id, BOTS.race(race, c));
    else if (p) pullInput(p, chan(p, 'r'), now, (k) => race.setInput(c.id, k));
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
  if (!match && !race && !vmatch && !hmatch && !tmatch) {
    nextTick = now;
    return;
  }
  if (now - nextTick > 250) nextTick = now; // uzun duraklamadan sonra yetişmeye çalışma
  let stepped = false;
  const wall = Date.now();
  while ((match || race || vmatch || hmatch || tmatch) && nextTick <= now) {
    if (tmatch) stepTMatch(wall);
    if (match) stepMatch(wall);
    if (vmatch) stepVMatch(wall);
    if (hmatch) stepHMatch(wall);
    if (race) stepRace(wall);
    nextTick += TICK_MS;
    stepped = true;
  }
  if (match) {
    for (const p of players.values()) syncCursorToDisc(p);
    if (stepped) broadcastMatch();
    if (match.phase === 'ended' && Date.now() >= endAt) stopMatch();
  }
  if (vmatch) {
    for (const p of players.values()) syncCursorToVb(p);
    if (stepped) broadcastVMatch();
    if (vmatch.phase === 'ended' && Date.now() >= vEndAt) stopVMatch();
  }
  if (tmatch) {
    for (const p of players.values()) syncCursorToTank(p);
    if (stepped) broadcastTMatch();
    if (tmatch.phase === 'ended' && Date.now() >= tEndAt) stopTMatch();
  }
  if (hmatch) {
    for (const p of players.values()) syncCursorToHk(p);
    if (stepped) broadcastHMatch();
    if (hmatch.phase === 'ended' && Date.now() >= hEndAt) stopHMatch();
  }
  if (race) {
    for (const p of players.values()) syncCursorToCar(p);
    if (stepped) broadcastRace();
    if (race.phase === 'ended' && Date.now() >= raceEndAt) stopRace();
  }
}, 4);

// ---------- Blackjack ----------
// Tek masa, en fazla 5 kişi, bot yok. Krupiye sunucu. Kazanan +1 puan (oyuncu listesindeki puan)
const BJ = WORLD.BJ;
const bj = new BJTable({
  change: () => broadcast(bj.snapshot(Date.now())),
  notice: (text) => { for (const s of bj.seats) if (s) notice(players.get(s.id) || {}, text); },
  kick: (id) => {
    const p = players.get(id);
    if (p) notice(p, 'İki eldir oynamadığın için masadan kaldırıldın.');
    bj.leave(id, Date.now());
  },
  settled: (results) => {
    for (const r of results) if ((r.res === 'win' || r.res === 'bj') && scores[r.id] != null) scores[r.id]++;
    broadcast({ t: 'bjres', results, scores });
  },
});
function bjSeated(p) {
  return bj.seatOf(p.id) >= 0;
}
function bjSit(p, i) {
  const busy = (match && match.players.has(p.id) && 'Futbol') || (vmatch && vmatch.players.has(p.id) && 'Voleybol') ||
    (hmatch && hmatch.players.has(p.id) && 'Hokey') || (tmatch && tmatch.players.has(p.id) && 'Tank') ||
    (race && race.cars.has(p.id) && 'Yarış');
  if (busy) return notice(p, `${busy} oyunundasın; önce L ile çık.`);
  if (bj.seatOf(p.id) < 0 && bj.seats.every(Boolean)) return notice(p, `Masa dolu (en fazla ${BJ.seats} kişi).`);
  const err = bj.sit(p.id, i, Date.now());
  if (err) return notice(p, err);
  // Masaya oturan diğer oyunların takım/katılım listelerinden çıkar
  if (p.team) setTeam(p, null);
  if (p.vteam) setVTeam(p, null);
  if (p.hteam) setHTeam(p, null);
  if (p.tanker) setTanker(p, false);
  if (p.racer) setRacer(p, false);
}
function bjAct(p, a) {
  const err = bj.act(p.id, a, Date.now());
  if (err) notice(p, err);
}
setInterval(() => bj.step(Date.now()), 50);

// ---------- İmleç yayını (30 Hz) ----------
setInterval(() => {
  if (players.size === 0) return;
  const p = [];
  for (const pl of players.values()) if (pl.ws || pl.bot) p.push([pl.id, Math.round(pl.x), Math.round(pl.y)]);
  broadcastFresh({ t: 'state', p });
}, 1000 / 30);

server.listen(PORT, () => console.log(`İmleç Kampı ${PORT} portunda çalışıyor`));
