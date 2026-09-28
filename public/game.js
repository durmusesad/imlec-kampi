(() => {
  'use strict';
  const W = window.WORLD;
  const INK = '#3b2f24';
  const INTERP_DELAY = 100; // ms — diğer oyuncular bu kadar geriden çizilir
  const SEND_EVERY = 33; // ms (~30 Hz)

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  // ---------- Durum ----------
  const me = { x: W.SPAWN.x, y: W.SPAWN.y, vx: 0, vy: 0, name: '', color: W.COLORS[0] };
  let myId = null;
  let joined = false;
  let locked = false;
  let chatting = false;
  let inAx = 0, inAy = 0; // bu karede biriken fare hareketi
  const players = new Map(); // id -> {id, name, color, snaps, chat, emote}
  let scores = {};
  const H = W.HAX;
  const MATCH_DELAY = 50; // ms — maç diskleri bu kadar geriden, akıcı çizilir
  const matchSnaps = []; // {t, p: Map(id -> {x, y, k}), b: {x, y}}
  let matchMeta = null; // son anlık görüntünün skor/süre bilgisi
  let lobby = { red: [], blue: [], running: false, last: null };
  const ball = { x: H.cx, y: H.cy, rot: 0 };
  const keys = new Set();
  let lastInput = -1;
  const pings = [];
  const cam = { x: 0, y: 0, init: false };
  let vw = innerWidth, vh = innerHeight, dpr = 1;

  // ---------- Giriş ekranı ----------
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('imlec-kampi:oyuncu') || '{}'); } catch {}
  const nameInput = $('name');
  nameInput.value = saved.name || '';
  me.color = W.COLORS.includes(saved.color) ? saved.color : W.COLORS[Math.floor(Math.random() * W.COLORS.length)];
  const colorsEl = $('colors');
  for (const c of W.COLORS) {
    const b = document.createElement('button');
    b.style.background = c;
    b.title = c;
    if (c === me.color) b.classList.add('sel');
    b.onclick = () => {
      me.color = c;
      colorsEl.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
    };
    colorsEl.appendChild(b);
  }
  nameInput.focus();
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('joinBtn').onclick = doJoin;

  function doJoin() {
    const name = nameInput.value.trim().slice(0, 16);
    if (!name) { nameInput.focus(); return; }
    me.name = name;
    try { localStorage.setItem('imlec-kampi:oyuncu', JSON.stringify({ name, color: me.color })); } catch {}
    joined = true;
    $('join').classList.add('hidden');
    ['players', 'hint'].forEach((id) => $(id).classList.remove('hidden'));
    $('resume').classList.remove('hidden'); // kilit alınınca pointerlockchange gizler
    connect();
    requestLock();
  }

  // ---------- Pointer Lock ----------
  function requestLock() {
    try {
      const r = canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => {});
    } catch {}
  }
  // Maçtaki oyuncu klavyeyle oynar; imleç kilidine ihtiyaç yok, "devam" ekranı gösterilmez
  function updateResume() {
    $('resume').classList.toggle('hidden', locked || !joined || inMatch());
    document.body.classList.toggle('playing', inMatch());
  }
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (!locked) { inAx = inAy = 0; if (!inMatch()) closeChat(); }
    updateResume();
  });
  document.addEventListener('pointerlockerror', updateResume);
  $('resume').addEventListener('click', requestLock);
  if (location.hostname === 'localhost') window.__imlec = { me, players, step: (dt) => stepMovement(dt), send: (m) => send(m) }; // yerel test kancası
  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    inAx += e.movementX;
    inAy += e.movementY;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (!joined) return;
    if (!locked) { requestLock(); return; }
    if (e.button !== 0 || inMatch()) return;
    for (const [name, pad] of Object.entries(W.PADS)) {
      if (W.inRect(me.x, me.y, pad)) {
        send({ t: 'pad', pad: name });
        return;
      }
    }
    addPing(me.x, me.y, me.color);
    send({ t: 'ping', x: me.x, y: me.y });
  });

  // ---------- Maç girdisi: WASD / oklar + Space (X) vuruş ----------
  const KEYMAP = {
    KeyW: 1, ArrowUp: 1, KeyS: 2, ArrowDown: 2, KeyA: 4, ArrowLeft: 4, KeyD: 8, ArrowRight: 8, Space: 16, KeyX: 16,
  };
  function inMatch() {
    return lobby.running && myId != null && (lobby.red.includes(myId) || lobby.blue.includes(myId));
  }
  function sendInput() {
    let k = 0;
    if (inMatch() && !chatting) for (const c of keys) k |= KEYMAP[c] || 0;
    if (k === lastInput) return;
    lastInput = k;
    send({ t: 'input', k });
  }
  document.addEventListener('keyup', (e) => {
    if (keys.delete(e.code)) sendInput();
  });
  addEventListener('blur', () => {
    keys.clear();
    sendInput();
  });

  // ---------- Klavye: sohbet ve emojiler ----------
  const chatInput = $('chat');
  function openChat() {
    chatting = true;
    $('chatbox').classList.remove('hidden');
    chatInput.value = '';
    chatInput.focus();
    keys.clear();
    sendInput();
  }
  function closeChat() {
    if (!chatting) return;
    chatting = false;
    chatInput.blur();
    $('chatbox').classList.add('hidden');
    keys.clear();
    sendInput();
  }
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { closeChat(); return; }
    if (e.key === 'Enter') {
      const text = chatInput.value.trim().slice(0, 80);
      if (text) {
        send({ t: 'chat', text });
        showChat(myId, text);
      }
      closeChat();
      e.preventDefault();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (!joined || chatting) return;
    const playing = inMatch();
    if (KEYMAP[e.code] && playing) {
      e.preventDefault();
      if (!keys.has(e.code)) {
        keys.add(e.code);
        sendInput();
      }
      return;
    }
    if (!locked && !playing) return;
    if (e.key === 'Enter') { openChat(); e.preventDefault(); return; }
    const n = '12345'.indexOf(e.key);
    if (n >= 0 && !e.repeat) {
      const em = W.EMOTES[n];
      send({ t: 'emote', e: em });
      showEmote(myId, em);
    }
  });

  // ---------- Ağ ----------
  let ws = null;
  let connected = false;
  let retries = 0;
  let lastSent = { x: -1, y: -1 };

  function setStatus(text) {
    $('status').textContent = text || '';
    $('status').classList.toggle('hidden', !text);
  }

  function connect() {
    setStatus('Bağlanıyor…');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      retries = 0;
      ws.send(JSON.stringify({ t: 'join', name: me.name, color: me.color, x: me.x, y: me.y }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      connected = false;
      myId = null;
      players.clear();
      lobby = { red: [], blue: [], running: false, last: null };
      matchSnaps.length = 0;
      matchMeta = null;
      lastInput = -1;
      renderPlayerList();
      updateHud();
      const delay = Math.min(5000, 400 * Math.pow(2, retries++));
      setStatus('Bağlantı koptu, yeniden bağlanılıyor…');
      setTimeout(connect, delay);
    };
  }

  function send(m) {
    if (connected && ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  function addPlayer(p) {
    players.set(p.id, { id: p.id, name: p.name, color: p.color, snaps: [{ t: performance.now(), x: p.x, y: p.y }], chat: null, emote: null });
  }

  function handle(m) {
    const now = performance.now();
    switch (m.t) {
      case 'welcome':
        myId = m.id;
        connected = true;
        setStatus('');
        players.clear();
        for (const p of m.players) addPlayer(p);
        scores = m.scores || {};
        renderPlayerList();
        break;
      case 'join':
        addPlayer(m.p);
        renderPlayerList();
        break;
      case 'leave':
        players.delete(m.id);
        delete scores[m.id];
        renderPlayerList();
        break;
      case 'state':
        for (const [id, x, y] of m.p) {
          if (id === myId) continue;
          const p = players.get(id);
          if (!p) continue;
          p.snaps.push({ t: now, x, y });
          if (p.snaps.length > 30) p.snaps.shift();
        }
        break;
      case 'lobby': {
        const was = inMatch();
        lobby = m;
        if (!m.running) {
          matchSnaps.length = 0;
          matchMeta = null;
        }
        if (was && !inMatch()) {
          // Maç bitti: imleç diskin son konumundan devam eder
          keys.clear();
          me.vx = me.vy = 0;
        }
        lastInput = -1;
        sendInput();
        updateResume();
        updateHud();
        break;
      }
      case 'g': {
        const pm = new Map();
        for (const [id, x, y, k] of m.p) pm.set(id, { x, y, k });
        matchSnaps.push({ t: now, p: pm, b: { x: m.b[0], y: m.b[1] } });
        if (matchSnaps.length > 60) matchSnaps.shift();
        const firstMeta = !matchMeta;
        matchMeta = m;
        if (firstMeta) updateResume();
        updateHud();
        break;
      }
      case 'overtime':
        announce('UZATMA!', '#fff');
        break;
      case 'end': {
        const t = m.winner ? H.teams[m.winner] : null;
        announce(t ? `${t.name} kazandı!` : 'Berabere!', t ? t.color : '#fff');
        break;
      }
      case 'chat':
        showChat(m.id, m.text);
        break;
      case 'ping': {
        const p = players.get(m.id);
        addPing(m.x, m.y, p ? p.color : '#fff');
        break;
      }
      case 'emote':
        showEmote(m.id, m.e);
        break;
      case 'goal': {
        scores = m.scores || scores;
        renderPlayerList();
        const p = m.by != null ? players.get(m.by) : null;
        const team = H.teams[m.team];
        const who = p ? (m.own ? `${p.name} (kendi kalesine)` : p.name) : team.name;
        announce(`GOL! ${who}`, team.color);
        break;
      }
      case 'full':
        setStatus('Oda dolu, biraz sonra tekrar dene.');
        break;
    }
  }

  setInterval(() => {
    if (!connected || myId == null) return;
    const x = Math.round(me.x * 10) / 10, y = Math.round(me.y * 10) / 10;
    if (x === lastSent.x && y === lastSent.y) return;
    lastSent = { x, y };
    send({ t: 'pos', x, y });
  }, SEND_EVERY);

  // ---------- Sosyal ----------
  function showChat(id, text) {
    const p = players.get(id);
    if (p) p.chat = { text, until: performance.now() + 5000 };
  }
  function showEmote(id, e) {
    const p = players.get(id);
    if (p) p.emote = { e, start: performance.now() };
  }
  function addPing(x, y, color) {
    pings.push({ x, y, color, start: performance.now() });
  }

  let goalTimer = null;
  function announce(text, color) {
    const el = $('goal');
    el.textContent = text;
    el.style.color = color || '#fff';
    el.classList.add('show');
    clearTimeout(goalTimer);
    goalTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  function updateHud() {
    const el = $('score');
    if (!lobby.running || !matchMeta) {
      el.classList.add('hidden');
      return;
    }
    const m = matchMeta;
    const sec = m.tm;
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    $('sRed').textContent = m.s[0];
    $('sBlue').textContent = m.s[1];
    $('sTime').textContent = m.ot ? `UZATMA ${mm}:${ss}` : `${mm}:${ss}`;
    el.classList.remove('hidden');
  }

  function renderPlayerList() {
    const list = $('plist');
    list.innerHTML = '';
    const arr = [...players.values()].sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0) || a.id - b.id);
    if (!arr.length) {
      list.innerHTML = '<div class="row" style="opacity:.6">—</div>';
      return;
    }
    for (const p of arr) {
      const row = document.createElement('div');
      row.className = 'row' + (p.id === myId ? ' me' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = p.name + (p.id === myId ? ' (sen)' : '');
      const g = document.createElement('span');
      g.className = 'goals';
      g.textContent = '⚽ ' + (scores[p.id] || 0);
      row.append(dot, nm, g);
      list.appendChild(row);
    }
  }

  // ---------- Hareket (arazi etkileri) ----------
  function stepMovement(dt) {
    const f = Math.min(dt * 60, 3); // 60 fps'e göre kare oranı
    const t = W.terrainAt(me.x, me.y);
    let decay;
    if (t.kind === 'ice') {
      // Buz: girdi hıza eklenir, momentum korunur
      me.vx += inAx * 0.09;
      me.vy += inAy * 0.09;
      const s = Math.hypot(me.vx, me.vy);
      if (s > 30) { me.vx *= 30 / s; me.vy *= 30 / s; }
      decay = Math.pow(W.ICE.friction, f);
    } else {
      let dx = inAx * t.mult, dy = inAy * t.mult;
      const d = Math.hypot(dx, dy), max = t.max * f;
      if (d > max) { dx *= max / d; dy *= max / d; }
      me.x += dx;
      me.y += dy;
      decay = Math.pow(0.9, f);
      if (t.force) {
        // Kararlı durumda hız = akıntı hızı (px/kare)
        me.vx += (t.force.x / 60) * (1 - decay) / decay;
        me.vy += (t.force.y / 60) * (1 - decay) / decay;
      }
    }
    me.x += me.vx * f;
    me.y += me.vy * f;
    me.vx *= decay;
    me.vy *= decay;
    if (Math.abs(me.vx) < 0.01) me.vx = 0;
    if (Math.abs(me.vy) < 0.01) me.vy = 0;
    if (me.x < 0) { me.x = 0; me.vx = 0; }
    if (me.x > W.W) { me.x = W.W; me.vx = 0; }
    if (me.y < 0) { me.y = 0; me.vy = 0; }
    if (me.y > W.H) { me.y = W.H; me.vy = 0; }
    // Maç sürerken seyirciler sahaya giremez: en yakın kenara itilir
    if (lobby.running && W.inRect(me.x, me.y, W.FIELD)) {
      const F = W.FIELD, m = 2;
      const d = [me.x - F.x, F.x + F.w - me.x, me.y - F.y, F.y + F.h - me.y];
      const i = d.indexOf(Math.min(...d));
      if (i === 0) { me.x = F.x - m; me.vx = 0; }
      else if (i === 1) { me.x = F.x + F.w + m; me.vx = 0; }
      else if (i === 2) { me.y = F.y - m; me.vy = 0; }
      else { me.y = F.y + F.h + m; me.vy = 0; }
    }
    inAx = inAy = 0;
  }

  function interp(snaps, rt) {
    if (!snaps.length) return null;
    if (rt <= snaps[0].t) return snaps[0];
    for (let i = snaps.length - 1; i > 0; i--) {
      const a = snaps[i - 1], b = snaps[i];
      if (rt >= a.t && rt <= b.t) {
        const k = b.t === a.t ? 1 : (rt - a.t) / (b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    return snaps[snaps.length - 1];
  }

  // ---------- Statik arka plan (bir kez çizilir) ----------
  function rng(seed) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function ellipse(c, e, grow = 0) {
    c.beginPath();
    c.ellipse(e.cx, e.cy, e.rx + grow, e.ry + grow, 0, 0, Math.PI * 2);
  }

  function riverPath(c) {
    const pts = W.RIVER.points;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  }

  const bg = document.createElement('canvas');
  bg.width = W.W;
  bg.height = W.H;
  (function drawBackground() {
    const c = bg.getContext('2d');
    const r = rng(42);
    // Kum
    c.fillStyle = '#ecd9a4';
    c.fillRect(0, 0, W.W, W.H);
    for (let i = 0; i < 2600; i++) {
      c.fillStyle = r() < 0.5 ? 'rgba(160,120,60,0.18)' : 'rgba(255,255,255,0.35)';
      c.beginPath();
      c.arc(r() * W.W, r() * W.H, 1 + r() * 2.2, 0, Math.PI * 2);
      c.fill();
    }
    // Çakıllar
    for (let i = 0; i < 70; i++) {
      const x = r() * W.W, y = r() * W.H;
      if (W.terrainAt(x, y).kind !== 'sand') continue;
      c.fillStyle = '#c9b78e';
      c.strokeStyle = 'rgba(59,47,36,0.35)';
      c.lineWidth = 2;
      c.beginPath();
      c.ellipse(x, y, 6 + r() * 8, 4 + r() * 5, r() * 3, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }

    // Kıyı şeritleri (su çizimi canlı yapılır, burada sadece ıslak kum)
    c.fillStyle = '#d8c28b';
    ellipse(c, W.LAKE, 18);
    c.fill();
    c.strokeStyle = '#d8c28b';
    c.lineWidth = W.RIVER.width + 30;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    riverPath(c);
    c.stroke();

    // Çamur
    c.fillStyle = '#8a6a4a';
    ellipse(c, W.MUD, 10);
    c.fill();
    c.fillStyle = '#7a5b3d';
    ellipse(c, W.MUD);
    c.fill();
    for (let i = 0; i < 60; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.9;
      const x = W.MUD.cx + Math.cos(a) * W.MUD.rx * d, y = W.MUD.cy + Math.sin(a) * W.MUD.ry * d;
      c.fillStyle = r() < 0.5 ? '#6a4c30' : '#94734f';
      c.beginPath();
      c.ellipse(x, y, 8 + r() * 22, 5 + r() * 12, r() * 3, 0, Math.PI * 2);
      c.fill();
    }

    // Buz pisti
    const I = W.ICE;
    c.fillStyle = INK;
    roundRect(c, I.x - 12, I.y - 12, I.w + 24, I.h + 24, 60);
    c.fill();
    c.fillStyle = '#ffffff';
    roundRect(c, I.x - 8, I.y - 8, I.w + 16, I.h + 16, 56);
    c.fill();
    const ig = c.createLinearGradient(I.x, I.y, I.x + I.w, I.y + I.h);
    ig.addColorStop(0, '#dff4ff');
    ig.addColorStop(1, '#b9e3f7');
    c.fillStyle = ig;
    roundRect(c, I.x, I.y, I.w, I.h, 50);
    c.fill();
    c.save();
    roundRect(c, I.x, I.y, I.w, I.h, 50);
    c.clip();
    c.strokeStyle = 'rgba(255,255,255,0.8)';
    c.lineWidth = 2;
    for (let i = 0; i < 40; i++) {
      const x = I.x + r() * I.w, y = I.y + r() * I.h, a = r() * Math.PI;
      c.beginPath();
      c.arc(x, y, 30 + r() * 80, a, a + 0.6 + r());
      c.stroke();
    }
    c.strokeStyle = 'rgba(220,60,60,0.5)';
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(I.x + I.w / 2, I.y);
    c.lineTo(I.x + I.w / 2, I.y + I.h);
    c.stroke();
    c.strokeStyle = 'rgba(60,110,220,0.45)';
    c.beginPath();
    c.arc(I.x + I.w / 2, I.y + I.h / 2, 60, 0, Math.PI * 2);
    c.stroke();
    c.restore();

    // HaxBall "Classic" stadyumu
    const F = W.FIELD, S = H.S;
    const hx = (x) => H.cx + x * S, hy = (y) => H.cy + y * S;
    c.fillStyle = INK;
    roundRect(c, F.x - 7, F.y - 7, F.w + 14, F.h + 14, 12);
    c.fill();
    c.fillStyle = '#718c5a';
    c.fillRect(F.x, F.y, F.w, F.h);
    // HaxBall çim deseni: top alanında dikey açık şeritler
    const stripeW = 30 * S;
    c.fillStyle = '#6b8454';
    for (let x = -H.ballAreaX; x < H.ballAreaX; x += 60) {
      c.fillRect(hx(x), hy(-H.ballAreaY), stripeW, H.ballAreaY * 2 * S);
    }
    c.strokeStyle = '#c7e6bd';
    c.lineWidth = 3 * S;
    c.lineCap = 'round';
    c.strokeRect(hx(-H.ballAreaX), hy(-H.ballAreaY), H.ballAreaX * 2 * S, H.ballAreaY * 2 * S);
    c.beginPath();
    c.moveTo(hx(0), hy(-H.ballAreaY));
    c.lineTo(hx(0), hy(H.ballAreaY));
    c.stroke();
    c.beginPath();
    c.arc(hx(0), hy(0), H.kickOffRadius * S, 0, Math.PI * 2);
    c.stroke();
    // Kaleler: ağ, kale çizgisi ve direkler
    for (const side of [-1, 1]) {
      const team = side < 0 ? 'red' : 'blue';
      const x0 = hx(side * H.ballAreaX), x1 = hx(side * (H.ballAreaX + H.goalDepth));
      c.fillStyle = 'rgba(0,0,0,0.12)';
      c.fillRect(Math.min(x0, x1), hy(-H.goalY), Math.abs(x1 - x0), H.goalY * 2 * S);
      c.strokeStyle = '#000';
      c.lineWidth = 2 * S;
      c.beginPath();
      c.moveTo(x0, hy(-H.goalY));
      c.lineTo(x1, hy(-H.goalY));
      c.lineTo(x1, hy(H.goalY));
      c.lineTo(x0, hy(H.goalY));
      c.stroke();
      c.strokeStyle = team === 'red' ? '#ffcccc' : '#ccccff';
      c.lineWidth = 3 * S;
      c.beginPath();
      c.moveTo(x0, hy(-H.goalY));
      c.lineTo(x0, hy(H.goalY));
      c.stroke();
      for (const t of [-1, 1]) {
        c.fillStyle = team === 'red' ? '#ffcccc' : '#ccccff';
        c.strokeStyle = '#000';
        c.lineWidth = 2 * S;
        c.beginPath();
        c.arc(x0, hy(t * H.goalY), H.postRadius * S, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      }
    }

    // Tabelalar
    function sign(x, y, text) {
      c.font = 'bold 22px Nunito, Trebuchet MS, sans-serif';
      const w = c.measureText(text).width + 28;
      c.fillStyle = '#8b5e34';
      c.fillRect(x - 4, y, 8, 46);
      c.fillStyle = INK;
      roundRect(c, x - w / 2 - 3, y - 37, w + 6, 42, 9);
      c.fill();
      c.fillStyle = '#c98d52';
      roundRect(c, x - w / 2, y - 34, w, 36, 7);
      c.fill();
      c.fillStyle = '#fff8ec';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, x, y - 16);
    }
    sign(1000, 290, '⚽ HaxBall Sahası');
    sign(2330, 895, '🌊 Göl');
    sign(1520, 170, '↘ Nehir');
    sign(720, 1335, '🟫 Çamur');
    sign(2400, 1180, '⛸️ Buz Pisti');
    sign(1500, 1070, '🏕️ Kamp');

    // Kamp ateşi (spawn yakını)
    c.fillStyle = '#9a9a9a';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      c.beginPath();
      c.arc(1500 + Math.cos(a) * 26, 1220 + Math.sin(a) * 16, 8, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = '#6b4226';
    c.fillRect(1480, 1214, 40, 10);

    // Ağaçlar
    for (const [x, y, s] of W.TREES) {
      c.fillStyle = 'rgba(59,47,36,0.18)';
      c.beginPath();
      c.ellipse(x + 8, y + s * 0.9, s * 0.95, s * 0.35, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#7a4f2a';
      c.fillRect(x - s * 0.12, y + s * 0.2, s * 0.24, s * 0.7);
      c.fillStyle = INK;
      c.beginPath();
      c.arc(x, y, s + 3, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#4f9d3a';
      c.beginPath();
      c.arc(x, y, s, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#66b84e';
      c.beginPath();
      c.arc(x - s * 0.3, y - s * 0.3, s * 0.55, 0, Math.PI * 2);
      c.fill();
    }
  })();

  // Göl dalgası noktaları
  const waveSpots = [];
  (function () {
    const r = rng(7);
    for (let i = 0; i < 400 && waveSpots.length < 34; i++) {
      const x = W.LAKE.cx + (r() * 2 - 1) * W.LAKE.rx, y = W.LAKE.cy + (r() * 2 - 1) * W.LAKE.ry;
      const e = { cx: W.LAKE.cx, cy: W.LAKE.cy, rx: W.LAKE.rx - 40, ry: W.LAKE.ry - 30 };
      if (W.inEllipse(x, y, e)) waveSpots.push([x, y, r() * 6]);
    }
  })();

  // Mini harita (statik kısım)
  const MM_S = 0.075;
  const mm = document.createElement('canvas');
  mm.width = Math.round(W.W * MM_S);
  mm.height = Math.round(W.H * MM_S);
  (function () {
    const c = mm.getContext('2d');
    c.drawImage(bg, 0, 0, mm.width, mm.height);
    c.save();
    c.scale(MM_S, MM_S);
    c.fillStyle = '#5ab4e5';
    ellipse(c, W.LAKE);
    c.fill();
    c.strokeStyle = '#5ab4e5';
    c.lineWidth = W.RIVER.width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    riverPath(c);
    c.stroke();
    c.restore();
  })();

  // ---------- Canlı çizim ----------
  function drawWater(time) {
    const s = time / 1000;
    // Göl
    const lg = ctx.createRadialGradient(W.LAKE.cx, W.LAKE.cy, 20, W.LAKE.cx, W.LAKE.cy, W.LAKE.rx);
    lg.addColorStop(0, '#3f9fd8');
    lg.addColorStop(1, '#6cc3ec');
    ctx.fillStyle = lg;
    ellipse(ctx, W.LAKE);
    ctx.fill();
    // Kıyıda hareketli köpük
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05) {
      const w = 6 + Math.sin(a * 12 + s * 2) * 3;
      const x = W.LAKE.cx + Math.cos(a) * (W.LAKE.rx - w);
      const y = W.LAKE.cy + Math.sin(a) * (W.LAKE.ry - w);
      a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Dalgacıklar
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const [x, y, ph] of waveSpots) {
      const dx = Math.sin(s * 0.8 + ph) * 10;
      const a = 0.5 + 0.5 * Math.sin(s * 1.5 + ph);
      ctx.globalAlpha = 0.35 + 0.65 * a;
      ctx.beginPath();
      ctx.moveTo(x + dx - 14, y);
      ctx.quadraticCurveTo(x + dx - 7, y - 6, x + dx, y);
      ctx.quadraticCurveTo(x + dx + 7, y + 6, x + dx + 14, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nehir
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#4aa8de';
    ctx.lineWidth = W.RIVER.width;
    riverPath(ctx);
    ctx.stroke();
    ctx.strokeStyle = '#3a97d0';
    ctx.lineWidth = W.RIVER.width * 0.45;
    riverPath(ctx);
    ctx.stroke();
    // Akıntı çizgileri
    ctx.setLineDash([26, 54]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineDashOffset = -s * W.RIVER.speed;
    riverPath(ctx);
    ctx.stroke();
    ctx.globalAlpha = 0.4;
    for (const off of [-28, 28]) {
      ctx.save();
      ctx.translate(off * 0.6, off * -0.4);
      ctx.lineDashOffset = -s * W.RIVER.speed * 0.6 + off;
      riverPath(ctx);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  // Maç anlık görüntüleri arasında ara değer
  function interpMatch(rt) {
    const n = matchSnaps.length;
    if (!n) return null;
    let a = matchSnaps[0], b = a;
    if (rt >= matchSnaps[n - 1].t) a = b = matchSnaps[n - 1];
    else {
      for (let i = n - 1; i > 0; i--) {
        if (rt >= matchSnaps[i - 1].t) {
          a = matchSnaps[i - 1];
          b = matchSnaps[i];
          break;
        }
      }
    }
    const k = b.t === a.t ? 1 : Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t)));
    const lerp = (u, v) => u + (v - u) * k;
    const p = new Map();
    for (const [id, pb] of b.p) {
      const pa = a.p.get(id) || pb;
      p.set(id, { x: lerp(pa.x, pb.x), y: lerp(pa.y, pb.y), k: pb.k });
    }
    return { p, b: { x: lerp(a.b.x, b.b.x), y: lerp(a.b.y, b.b.y) } };
  }

  let matchView = null; // bu karede çizilen maç durumu
  function drawMatch(time, mv) {
    matchView = mv;
    const S = H.S;
    const bpos = matchView ? matchView.b : { x: H.cx, y: H.cy };
    ball.x = bpos.x;
    ball.y = bpos.y;
    if (matchView) {
      for (const [id, d] of matchView.p) {
        const pl = players.get(id);
        const team = lobby.red.includes(id) ? 'red' : 'blue';
        drawDisc(pl, d, team, id === myId, time);
      }
    }
    // Top (HaxBall: beyaz disk, siyah kenar)
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2 * S;
    ctx.beginPath();
    ctx.arc(bpos.x, bpos.y, H.ball.radius * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  function drawDisc(pl, d, team, isMe, time) {
    const S = H.S, r = H.player.radius * S;
    ctx.fillStyle = H.teams[team].color;
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2 * S;
    ctx.strokeStyle = d.k ? '#fff' : '#000';
    ctx.stroke();
    if (isMe) {
      // Kendi diskin: HaxBall'daki gibi ince beyaz halka
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(d.x, d.y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (!pl) return;
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(13 * S)}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText([...pl.name].slice(0, 2).join('').toUpperCase(), d.x, d.y + 1);
    ctx.font = `bold ${Math.round(9 * S)}px Arial, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3;
    ctx.strokeText(pl.name, d.x, d.y + r + 12);
    ctx.fillText(pl.name, d.x, d.y + r + 12);
    ctx.save();
    ctx.translate(d.x - 6, d.y - r + 4);
    drawSocial(pl, time);
    ctx.restore();
  }

  function drawPads(time) {
    const hover = joined && !inMatch() ? me : null;
    for (const [name, pad] of Object.entries(W.PADS)) {
      const isTeam = name !== 'start';
      const over = hover && W.inRect(hover.x, hover.y, pad);
      let fill, title, lines = [];
      if (isTeam) {
        const t = H.teams[name];
        fill = t.color;
        title = `${t.name} Takım`;
        lines = lobby[name].map((id) => (players.get(id) || {}).name).filter(Boolean);
        if (!lines.length) lines = ['(boş — tıkla, katıl)'];
      } else {
        fill = lobby.running ? '#8a8a8a' : '#f0a93b';
        title = lobby.running ? '⏹ Maçı Bitir' : '▶ Maçı Başlat';
        if (lobby.running) lines = ['Maç sürüyor'];
        else if (!lobby.red.length && !lobby.blue.length) lines = ['Önce takım seç'];
        else lines = [`${lobby.red.length} - ${lobby.blue.length} oyuncu hazır`];
        if (!lobby.running && lobby.last) {
          const L = lobby.last;
          lines.push(`Son maç: ${L.score.red}-${L.score.blue}`);
        }
      }
      ctx.save();
      if (over) {
        ctx.translate(pad.x + pad.w / 2, pad.y + pad.h / 2);
        ctx.scale(1.04, 1.04);
        ctx.translate(-(pad.x + pad.w / 2), -(pad.y + pad.h / 2));
      }
      ctx.fillStyle = INK;
      roundRect(ctx, pad.x + 4, pad.y + 5, pad.w, pad.h, 14);
      ctx.fill();
      ctx.fillStyle = fill;
      roundRect(ctx, pad.x, pad.y, pad.w, pad.h, 14);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 19px Nunito, Trebuchet MS, sans-serif';
      ctx.fillText(title, pad.x + pad.w / 2, pad.y + 10);
      ctx.font = '600 13px Nunito, Trebuchet MS, sans-serif';
      const shown = lines.slice(0, 3);
      if (lines.length > 3) shown[2] = `+${lines.length - 2} kişi`;
      shown.forEach((l, i) => ctx.fillText(l, pad.x + pad.w / 2, pad.y + 38 + i * 16));
      ctx.restore();
    }
    // Kısa açıklama
    ctx.fillStyle = 'rgba(59,47,36,0.75)';
    ctx.font = '600 14px Nunito, Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('Takım alanına tıkla → hazırsın. Maçta: WASD/oklar hareket, Space vuruş.', 1000, 1098);
  }

  function drawPings(time) {
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i];
      const k = (time - p.start) / 900;
      if (k >= 1) { pings.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - k, 3);
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 6 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8 + e * 60, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8 + e * 60 + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const ARROW = [[0, 0], [0, 23], [5.5, 18], [9.5, 27], [13.5, 25.5], [9.5, 16.5], [16.5, 16.5]];
  function arrowPath() {
    ctx.beginPath();
    ARROW.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
  function drawArrow(color) {
    arrowPath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function wavePath(time, top) {
    // İmlecin (yerel koordinatta) su çizgisi; top=true ise suyun üstü, false ise altı
    const wl = 12, s = time / 1000;
    ctx.beginPath();
    ctx.moveTo(-10, wl);
    for (let x = -10; x <= 30; x += 2) ctx.lineTo(x, wl + Math.sin(x * 0.45 + s * 6) * 2.2);
    ctx.lineTo(30, top ? -20 : 40);
    ctx.lineTo(-10, top ? -20 : 40);
    ctx.closePath();
  }

  function drawCursor(p, x, y, time, isMe) {
    const kind = W.terrainAt(x, y).kind;
    ctx.save();
    ctx.translate(x, y);
    if (W.isWater(kind)) {
      ctx.save();
      wavePath(time, false);
      ctx.clip();
      ctx.globalAlpha = 0.28;
      drawArrow(p.color);
      ctx.restore();
      ctx.save();
      wavePath(time, true);
      ctx.clip();
      drawArrow(p.color);
      ctx.restore();
      const s = time / 1000;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let xx = -6; xx <= 22; xx += 2) {
        const yy = 12 + Math.sin(xx * 0.45 + s * 6) * 2.2;
        xx === -6 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    } else if (kind === 'mud') {
      drawArrow(p.color);
      ctx.fillStyle = 'rgba(106,76,48,0.55)';
      ctx.beginPath();
      ctx.moveTo(-2, 16);
      ctx.quadraticCurveTo(8, 12, 18, 16);
      ctx.lineTo(18, 30);
      ctx.lineTo(-2, 30);
      ctx.fill();
    } else {
      drawArrow(p.color);
    }

    // İsim etiketi
    ctx.font = 'bold 12px Nunito, Trebuchet MS, sans-serif';
    const label = p.name;
    const tw = ctx.measureText(label).width;
    const lx = 10, ly = 34;
    ctx.fillStyle = p.color;
    roundRect(ctx, lx - 4, ly - 2, tw + 12, 19, 7);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, lx + 2, ly + 1.5);

    drawSocial(p, time);
    ctx.restore();
  }

  // Sohbet balonu ve emoji (ctx, imlecin/diskin tepesine taşınmış olmalı)
  function drawSocial(p, time) {
    // Sohbet balonu
    if (p.chat && time < p.chat.until) {
      ctx.font = '600 14px Nunito, Trebuchet MS, sans-serif';
      const lines = wrap(p.chat.text, 220);
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
      const h = lines.length * 18 + 12;
      const fade = Math.min(1, (p.chat.until - time) / 400);
      ctx.globalAlpha = fade;
      const bx = 6, by = -10 - h;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      roundRect(ctx, bx, by, w, h, 10);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx + 10, by + h - 1);
      ctx.lineTo(bx + 4, by + h + 8);
      ctx.lineTo(bx + 20, by + h - 1);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, bx + 10, by + 7 + i * 18));
      ctx.globalAlpha = 1;
    } else if (p.chat) {
      p.chat = null;
    }

    // Emoji
    if (p.emote) {
      const k = (time - p.emote.start) / 2200;
      if (k >= 1) p.emote = null;
      else {
        const pop = k < 0.15 ? k / 0.15 : 1;
        const sc = 0.5 + pop * 0.7 + Math.sin(k * 20) * 0.05 * (1 - k);
        ctx.globalAlpha = k > 0.8 ? (1 - k) / 0.2 : 1;
        ctx.font = `${Math.round(28 * sc)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.emote.e, 30, -8 - k * 30);
        ctx.globalAlpha = 1;
      }
    }
  }

  function wrap(text, maxW) {
    const words = text.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function drawMinimap() {
    const pad = 14;
    const x0 = vw - mm.width - pad, y0 = vh - mm.height - pad;
    ctx.fillStyle = INK;
    roundRect(ctx, x0 - 4, y0 - 4, mm.width + 8, mm.height + 8, 10);
    ctx.fill();
    ctx.save();
    roundRect(ctx, x0, y0, mm.width, mm.height, 7);
    ctx.clip();
    ctx.drawImage(mm, x0, y0);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + cam.x * MM_S, y0 + cam.y * MM_S, vw * MM_S, vh * MM_S);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x0 + ball.x * MM_S, y0 + ball.y * MM_S, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (const p of players.values()) {
      const pos = p.id === myId ? me : p.render;
      if (!pos) continue;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x0 + pos.x * MM_S, y0 + pos.y * MM_S, p.id === myId ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- Döngü ----------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = innerWidth;
    vh = innerHeight;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = vw + 'px';
    canvas.style.height = vh + 'px';
  }
  addEventListener('resize', resize);
  resize();

  function updateCamera(dt) {
    const tx = me.x - vw / 2, ty = me.y - vh / 2;
    const k = cam.init ? 1 - Math.exp(-dt * 5) : 1;
    cam.init = true;
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    const clampAxis = (v, view, size) => (view >= size ? (size - view) / 2 : Math.max(0, Math.min(size - view, v)));
    cam.x = clampAxis(cam.x, vw, W.W);
    cam.y = clampAxis(cam.y, vh, W.H);
  }

  let last = performance.now();
  function frame(time) {
    const dt = Math.min(0.1, (time - last) / 1000);
    last = time;
    const mv = lobby.running ? interpMatch(time - MATCH_DELAY) : null;
    const myDisc = inMatch() && mv ? mv.p.get(myId) : null;
    if (myDisc) {
      // Maçtayken "imleç" kendi diskindir; kamera onu takip eder
      me.x = myDisc.x;
      me.y = myDisc.y;
      me.vx = me.vy = 0;
      inAx = inAy = 0;
    } else if (joined && !inMatch()) stepMovement(dt);
    updateCamera(dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#d9c38c';
    ctx.fillRect(0, 0, vw, vh);
    ctx.save();
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));
    const sx = Math.max(0, Math.floor(cam.x)), sy = Math.max(0, Math.floor(cam.y));
    const sw = Math.min(W.W - sx, Math.ceil(vw) + 2), sh = Math.min(W.H - sy, Math.ceil(vh) + 2);
    if (sw > 0 && sh > 0) ctx.drawImage(bg, sx, sy, sw, sh, sx, sy, sw, sh);
    drawWater(time);
    drawPads(time);
    drawMatch(time, mv);
    drawPings(time);

    const rt = time - INTERP_DELAY;
    for (const p of players.values()) {
      if (p.id === myId) continue;
      p.render = interp(p.snaps, rt);
      if (p.render && !(mv && mv.p.has(p.id))) drawCursor(p, p.render.x, p.render.y, time, false);
    }
    if (joined && !myDisc) {
      const self = players.get(myId) || { name: me.name, color: me.color };
      drawCursor(self, me.x, me.y, time, true);
    }
    ctx.restore();
    if (joined) drawMinimap();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
