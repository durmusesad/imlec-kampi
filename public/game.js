(() => {
  'use strict';
  const W = window.WORLD;
  const HB = window.HAXBALL;
  const H = W.HAX;
  const INK = '#3b2f24';
  const INTERP_DELAY = 100; // ms — diğer imleçler bu kadar geriden çizilir
  const SEND_EVERY = 33; // ms (~30 Hz)
  const TICK = 1 / HB.TPS;
  // Kendi girdimizi kaç adım geç uygulayalım: sunucudaki girdi tamponu kadar (2–5 adım, 33–83 ms).
  // Böylece dünya daha az ileriye tahmin edilir; top/rakip ışınlanmaları büyük ölçüde kaybolur
  let inputDelayTicks = 2;

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { alpha: false });
  const $ = (id) => document.getElementById(id);

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ---------- Durum ----------
  const me = { x: W.SPAWN.x, y: W.SPAWN.y, vx: 0, vy: 0, name: '', color: W.COLORS[0] };
  let myId = null;
  let joined = false;
  let locked = false; // imleç kilidi = "oyun modu"; kilit yoksa normal imleç modu
  let chatting = false;
  let inAx = 0, inAy = 0; // bu karede biriken fare hareketi
  const players = new Map(); // id -> {id, name, color, snaps, chat, emote, render}
  let scores = {};
  let lobby = { red: [], blue: [], running: false, last: null };
  const ball = { x: H.cx, y: H.cy };
  const keys = new Set();
  const cam = { x: 0, y: 0, init: false };
  let vw = innerWidth, vh = innerHeight, dpr = 1;

  // Maç tahmini (HaxBall gibi): istemci aynı fiziği çalıştırır, sunucu durumu gelince düzeltir
  let sim = null; // HB.Match
  let meta = null; // son sunucu anlık görüntüsü
  let simAcc = 0;
  let seq = 0;
  let pending = []; // sunucunun henüz uygulamadığı kendi girdilerimiz [seq, bits]
  let prevPos = new Map(); // son adımdan önceki konumlar (kareler arası yumuşatma)
  const offsets = new Map(); // düzeltmelerde oluşan görsel sapma, zamanla sönümlenir
  let corrStats = null; // yerel testte düzeltme istatistiği

  // Hızlı emoji menüsü (kişiye özel, tarayıcıda saklanır)
  let quick = store.get('imlec-kampi:hizli-emoji', null);
  if (!Array.isArray(quick) || quick.length !== 8 || !quick.every((e) => W.EMOJI_PALETTE.includes(e))) {
    quick = W.DEFAULT_QUICK.slice();
  }
  let radial = null; // {vx, vy, sel} — açıkken fare hareketi seçimi yönlendirir
  let isAdmin = false;
  let mutedIds = new Set(); // (yönetici) susturulmuş oyuncular
  let kicked = false;

  // Yeniden bağlanınca aynı oyuncu olarak dönebilmek için sekmeye özel anahtar
  let token = null;
  token = store.get('imlec-kampi:token', null);
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
    store.set('imlec-kampi:token', token);
  }

  // ---------- Giriş ekranı ----------
  const saved = store.get('imlec-kampi:oyuncu', {}) || {};
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
    store.set('imlec-kampi:oyuncu', { name, color: me.color });
    joined = true;
    $('join').classList.add('hidden');
    ['players', 'keys', 'chatlog'].forEach((id) => $(id).classList.remove('hidden'));
    flashKeys();
    connect();
    requestLock();
    updateModeUi();
  }

  // ---------- Oyun modu / normal imleç modu ----------
  // Oyun modu: imleç kilitli, site her şeyi dinler. Normal mod (Q veya Esc): gerçek imleç geri gelir,
  // site hiçbir tıklamaya/tuşa tepki vermez; çift tıklayınca oyun moduna dönülür.
  function requestLock() {
    try {
      const r = canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => {});
    } catch {}
  }
  function updateModeUi() {
    document.body.classList.toggle('normal', joined && !locked);
    $('adminBar').classList.toggle('hidden', !joined || kicked);
    // Oyun durdu: tuş tablosunun tamamı ekranın ortasında görünür (emoji paneli açıkken değil)
    document.body.classList.toggle('paused', joined && !locked && $('emojiPanel').classList.contains('hidden'));
    sendStatus();
  }

  // Tuş rehberi: kısa süre görünüp kaybolur (girişte, maça girip çıkınca, H ile)
  let keysTimer = null;
  function flashKeys(ms = 6000) {
    const el = $('keys');
    el.classList.add('show');
    clearTimeout(keysTimer);
    keysTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // Durumumu diğerlerine bildir: uzakta (oyun durdu / sekme arka planda) ya da yazıyor
  let sentStatus = '';
  function sendStatus(force) {
    const afk = joined && (!locked || document.hidden);
    const typing = chatting && !afk;
    const self = players.get(myId);
    if (self) { self.afk = afk; self.typing = typing; }
    const key = afk + '|' + typing;
    if (!force && key === sentStatus) return;
    sentStatus = key;
    send({ t: 'status', afk, typing });
  }
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (!locked) {
      inAx = inAy = 0;
      radial = null;
      keys.clear();
      closeChat();
    }
    updateModeUi();
  });
  document.addEventListener('pointerlockerror', updateModeUi);
  canvas.addEventListener('dblclick', () => {
    if (joined && !locked) requestLock();
  });
  document.addEventListener('contextmenu', (e) => {
    if (joined && locked) e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    if (radial) {
      // Menü açıkken fare imleci değil seçimi hareket ettirir
      radial.vx += e.movementX;
      radial.vy += e.movementY;
      const len = Math.hypot(radial.vx, radial.vy);
      if (len > 90) { radial.vx *= 90 / len; radial.vy *= 90 / len; }
      radial.sel = len > 28 ? sectorOf(radial.vx, radial.vy) : -1;
      return;
    }
    inAx += e.movementX;
    inAy += e.movementY;
  });

  function sectorOf(x, y) {
    // 0 = üst, saat yönünde 8 dilim
    const a = Math.atan2(y, x) + Math.PI / 2;
    return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  }

  canvas.addEventListener('mousedown', (e) => {
    if (!joined || !locked) return; // normal modda tek tıklama hiçbir şey yapmaz
    if (e.button === 2) {
      radial = { vx: 0, vy: 0, sel: -1 };
      return;
    }
    if (e.button !== 0) return;
    if (radial) {
      pickRadial();
      return;
    }
    if (inMatch() || inRace()) return;
    // Sol tık sadece etkileşimli alanlarda bir şey yapar (boş yere tıklamak hiçbir şey göndermez)
    for (const [name, pad] of Object.entries(W.PADS)) {
      if (W.inRect(me.x, me.y, pad)) {
        send({ t: 'pad', pad: name });
        return;
      }
    }
    for (const [name, pad] of Object.entries(TR.PADS)) {
      if (W.inRect(me.x, me.y, pad)) {
        send({ t: 'rpad', pad: name });
        return;
      }
    }
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 2 && radial) pickRadial();
  });
  function pickRadial() {
    if (radial && radial.sel >= 0) sendEmote(quick[radial.sel]);
    radial = null;
  }
  function sendEmote(em) {
    send({ t: 'emote', e: em });
    showEmote(myId, em);
  }

  // ---------- Klavye ----------
  const KEYMAP = {
    KeyW: 1, ArrowUp: 1, KeyS: 2, ArrowDown: 2, KeyA: 4, ArrowLeft: 4, KeyD: 8, ArrowRight: 8, Space: 16, KeyX: 16,
  };
  function inMatch() {
    return lobby.running && myId != null && (lobby.red.includes(myId) || lobby.blue.includes(myId));
  }
  function myTeam() {
    return lobby.red.includes(myId) ? 'red' : lobby.blue.includes(myId) ? 'blue' : null;
  }
  function inputBits() {
    if (!locked || chatting) return 0;
    let k = 0;
    for (const c of keys) k |= KEYMAP[c] || 0;
    return k;
  }
  document.addEventListener('keyup', (e) => keys.delete(e.code));
  // Sekme/pencere arka plana geçince tuşları bırak ve sunucuya hemen bildir
  function releaseAll() {
    keys.clear();
    if (inMatch() && sim) {
      seq++;
      pending.push([seq, 0]);
      send({ t: 'i', s: seq, k: 0 });
    }
    if (inRace() && rsim) {
      rseq++;
      rpending.push([rseq, 0]);
      send({ t: 'ri', s: rseq, k: 0 });
    }
  }
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
    sendStatus();
  });

  document.addEventListener('keydown', (e) => {
    if (!joined || chatting || !locked) return; // normal modda tuşlar siteye gitmez
    const playing = inMatch() || inRace();
    if (KEYMAP[e.code] && playing) {
      e.preventDefault();
      keys.add(e.code);
      return;
    }
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyQ':
        document.exitPointerLock();
        return;
      case 'KeyT':
      case 'Enter':
        e.preventDefault();
        openChat();
        return;
      case 'KeyL':
        if (myTeam() || (lobby.racers || []).includes(myId)) send({ t: 'leave' });
        return;
      case 'KeyE':
        openEmojiPanel();
        return;
      case 'KeyH':
        flashKeys();
        return;
    }
    const n = /^Digit([1-8])$/.exec(e.code);
    if (n) sendEmote(quick[+n[1] - 1]);
  });

  // ---------- Sohbet ----------
  const chatInput = $('chat');
  chatInput.maxLength = W.CHAT_MAX;
  function openChat() {
    chatting = true;
    keys.clear();
    $('chatbox').classList.remove('hidden');
    $('chatlog').classList.add('open');
    chatInput.value = '';
    updateCounter();
    chatInput.focus();
    sendStatus();
  }
  function closeChat() {
    if (!chatting) return;
    chatting = false;
    chatInput.blur();
    $('chatbox').classList.add('hidden');
    $('chatlog').classList.remove('open');
    sendStatus();
  }
  function updateCounter() {
    const n = [...chatInput.value].length;
    $('counter').textContent = `${n}/${W.CHAT_MAX}`;
    $('counter').classList.toggle('full', n >= W.CHAT_MAX);
  }
  chatInput.addEventListener('input', updateCounter);
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { closeChat(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = chatInput.value.trim().slice(0, W.CHAT_MAX);
      if (text) send({ t: 'chat', text });
      closeChat();
    }
  });

  // Sohbet geçmişi sadece sohbet açıkken görünür; yeni mesajlar birkaç saniye görünüp kaybolur
  function addChatLine(m, history) {
    const log = $('chatlog');
    const row = document.createElement('div');
    row.className = 'line';
    const nm = document.createElement('b');
    nm.textContent = m.name + ': ';
    nm.style.color = m.color;
    const tx = document.createElement('span');
    tx.textContent = m.text;
    row.append(nm, tx);
    log.appendChild(row);
    while (log.children.length > 30) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    if (history) row.classList.add('old');
    else setTimeout(() => row.classList.add('old'), 5000);
  }

  // ---------- Hızlı emoji ayarları ----------
  let slotSel = 0;
  function renderEmojiPanel() {
    const slots = $('slots');
    slots.innerHTML = '';
    quick.forEach((em, i) => {
      const b = document.createElement('button');
      b.className = 'slot' + (i === slotSel ? ' sel' : '');
      b.innerHTML = `<span class="em"></span><span class="k">${i + 1}</span>`;
      b.firstChild.textContent = em;
      b.onclick = () => { slotSel = i; renderEmojiPanel(); };
      slots.appendChild(b);
    });
    const pal = $('palette');
    if (!pal.children.length) {
      for (const em of W.EMOJI_PALETTE) {
        const b = document.createElement('button');
        b.textContent = em;
        b.onclick = () => {
          quick[slotSel] = em;
          slotSel = (slotSel + 1) % 8;
          store.set('imlec-kampi:hizli-emoji', quick);
          renderEmojiPanel();
        };
        pal.appendChild(b);
      }
    }
  }
  function openEmojiPanel() {
    renderEmojiPanel();
    $('emojiPanel').classList.remove('hidden');
    document.exitPointerLock();
    updateModeUi();
  }
  $('emojiReset').onclick = () => {
    quick = W.DEFAULT_QUICK.slice();
    store.set('imlec-kampi:hizli-emoji', quick);
    renderEmojiPanel();
  };
  $('emojiClose').onclick = () => {
    $('emojiPanel').classList.add('hidden');
    requestLock();
    updateModeUi();
  };

  // ---------- Ağ ----------
  let ws = null;
  let connected = false;
  let retries = 0;
  let lastSent = { x: -1, y: -1 };

  function setStatus(text) {
    $('status').textContent = text || '';
    $('status').classList.toggle('hidden', !text);
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  function connect() {
    setStatus('Bağlanıyor…');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      retries = 0;
      ws.send(JSON.stringify({ t: 'join', name: me.name, color: me.color, x: me.x, y: me.y, token, adminKey: store.get('imlec-kampi:yonetici', null) }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      connected = false;
      if (kicked) return; // atılan kişi otomatik geri bağlanmaz
      const delay = Math.min(5000, 300 * Math.pow(2, retries++));
      setStatus('Bağlantı koptu, yeniden bağlanılıyor…');
      setTimeout(connect, delay);
    };
  }

  // Sayfadan çıkarken sunucuya haber ver: eski imleç haritada kalmasın
  addEventListener('pagehide', () => {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: 'bye' }));
        ws.close(1000);
      }
    } catch {}
  });

  function send(m) {
    if (connected && ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  function addPlayer(p) {
    const old = players.get(p.id);
    players.set(p.id, {
      id: p.id, name: p.name, color: p.color,
      snaps: [{ t: performance.now(), x: p.x, y: p.y }],
      chat: old ? old.chat : null, emote: old ? old.emote : null,
      afk: !!p.afk, typing: !!p.typing, admin: !!p.admin,
    });
  }

  function resetMatchView() {
    sim = null;
    meta = null;
    pending = [];
    offsets.clear();
    prevPos = new Map();
    simAcc = 0;
  }

  function handle(m) {
    const now = performance.now();
    switch (m.t) {
      case 'welcome':
        myId = m.id;
        connected = true;
        setAdmin(!!m.admin);
        if (!m.admin) store.set('imlec-kampi:yonetici', null); // eski/geçersiz anahtar
        setStatus('');
        players.clear();
        for (const p of m.players) addPlayer(p);
        scores = m.scores || {};
        resetMatchView();
        if (!m.restored) {
          $('chatlog').querySelectorAll('.line').forEach((n) => n.remove());
          for (const c of m.chat || []) addChatLine(c, true);
        }
        renderPlayerList();
        sendStatus(true);
        break;
      case 'join':
        addPlayer(m.p);
        renderPlayerList();
        break;
      case 'away': // bağlantısı koptu; geri dönerse 'join' ile tekrar gelir
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
        const wasIn = inMatch(), wasRace = inRace();
        lobby = m;
        document.body.classList.toggle('in-match', inMatch());
        document.body.classList.toggle('in-race', inRace());
        if (!m.running) resetMatchView();
        if (!m.raceRunning) resetRaceView();
        if (wasIn !== inMatch() || wasRace !== inRace()) {
          flashKeys(); // maça/yarışa girince/çıkınca ilgili tuşları kısaca göster
          keys.clear(); // sadece kendi durumum değişince; başkası takım değiştirince tuşlarım bırakılmasın
        }
        renderPlayerList();
        updateHud();
        break;
      }
      case 'g':
        onSnapshot(m);
        break;
      case 'rg':
        onRaceSnapshot(m);
        break;
      case 'rlights':
        lightsAt = performance.now();
        goAt = 0;
        break;
      case 'rgo':
        goAt = performance.now();
        if (inRace() || nearTrack()) announce('BAŞLA!', '#fff', 'Istanbul Park · ' + RC.LAPS + ' tur');
        break;
      case 'rlap':
        if (m.id === myId) toast(`Tur ${m.lap} bitti · ${fmtTime(m.time)}`);
        break;
      case 'rfinish': {
        const p = players.get(m.id);
        if (m.id === myId) announce(`${m.pos}. oldun!`, '#fff', fmtTime(m.time));
        else if (p && (inRace() || nearTrack())) toast(`🏁 ${p.name} ${m.pos}. olarak bitirdi`);
        break;
      }
      case 'rend':
        showRaceResults(m);
        break;
      case 'tp':
        me.x = m.x;
        me.y = m.y;
        me.vx = me.vy = 0;
        break;
      case 'notice':
        toast(m.text);
        break;
      case 'halftime':
        announce('DEVRE ARASI', '#fff', 'Taraflar değişiyor');
        break;
      case 'end': {
        const t = m.winner ? H.teams[m.winner] : null;
        const sub = m.reason === 'empty' ? 'Sahada oyuncu kalmadı' : `${m.score.red} - ${m.score.blue}`;
        if (m.reason === 'empty') announce('Maç bitti', '#fff', sub);
        else announce(t ? `${t.name} kazandı!` : 'Berabere!', t ? t.color : '#fff', sub);
        break;
      }
      case 'chat':
        showChat(m.id, m.text);
        addChatLine(m);
        break;
      case 'emote':
        showEmote(m.id, m.e);
        break;
      case 'status': {
        const p = players.get(m.id);
        if (p) { p.afk = m.afk; p.typing = m.typing; }
        break;
      }
      case 'goal': {
        scores = m.scores || scores;
        renderPlayerList();
        const p = m.by != null ? players.get(m.by) : null;
        const team = H.teams[m.team];
        const who = p ? (m.own ? `${p.name} (kendi kalesine)` : p.name) : team.name;
        announce(`GOL! ${who}`, team.color, `${m.score.red} - ${m.score.blue}`);
        break;
      }
      case 'full':
        setStatus('Oda dolu, biraz sonra tekrar dene.');
        break;
      case 'adminOk':
        store.set('imlec-kampi:yonetici', m.key);
        setAdmin(true);
        closeAdminModal(false);
        toast('Yönetici girişi yapıldı 👑');
        break;
      case 'adminFail':
        $('adminErr').textContent = m.text;
        $('adminPw').select();
        break;
      case 'muted':
        mutedIds = new Set(m.ids);
        renderPlayerList();
        break;
      case 'kicked':
        kicked = true;
        document.exitPointerLock();
        $('kickedScreen').classList.remove('hidden');
        updateModeUi();
        break;
      case 'clearChat':
        $('chatlog').querySelectorAll('.line').forEach((n) => n.remove());
        break;
    }
  }

  setInterval(() => {
    if (!connected || myId == null || inMatch()) return;
    const x = Math.round(me.x * 10) / 10, y = Math.round(me.y * 10) / 10;
    if (x === lastSent.x && y === lastSent.y) return;
    lastSent = { x, y };
    send({ t: 'pos', x, y });
  }, SEND_EVERY);

  // ---------- Maç tahmini ----------
  function simPositions() {
    const m = new Map();
    for (const p of sim.players.values()) m.set(p.id, { x: p.x, y: p.y });
    m.set('ball', { x: sim.ball.x, y: sim.ball.y });
    return m;
  }

  function simStep(bits) {
    prevPos = simPositions();
    if (bits != null) sim.setInput(myId, bits);
    sim.step(true);
  }

  function onSnapshot(g) {
    meta = g;
    if (!lobby.running) return;
    if (!sim) {
      sim = new HB.Match();
      sim.load(g);
      pending = [];
      prevPos = simPositions();
      updateHud();
      return;
    }
    // Önceki sapmayı hariç tutarak ölç; yoksa sapma her güncellemede kendini tekrar ekleyip büyür
    // Ekranda o an çizilen ara konuma (alpha) göre ölç ki düzeltme görsel olarak kesintisiz olsun
    const alpha = Math.min(1, simAcc / TICK);
    const before = renderPositions(alpha, true);
    sim.load(g);
    const mine = g.p.find((q) => q[0] === myId);
    if (mine) {
      const ack = mine[8];
      // Sunucu tamponuna doğru her güncellemede en fazla 1 adım yaklaş (ani sıçrama olmasın)
      const want = Math.max(2, Math.min(3, mine[9] || 2));
      if (want > inputDelayTicks) inputDelayTicks++;
      else if (want < inputDelayTicks) inputDelayTicks--;
      pending = pending.filter(([s]) => s > ack);
      if (pending.length > 90) pending = pending.slice(-90);
      // Sunucunun henüz işlemediği girdilerimizi yeniden oynat. Son INPUT_DELAY girdi henüz oynatılmaz:
      // dünya o kadar az ileriye tahmin edilir (rakip/top düzeltmeleri küçülür), karşılığında kendi
      // tuşlarımız INPUT_DELAY adım geç görünür (HaxBall'daki giriş gecikmesi gibi)
      const upto = Math.max(0, pending.length - inputDelay());
      for (let i = 0; i < upto; i++) simStep(pending[i][1]);
      if (!upto) prevPos = simPositions();
    } else {
      pending = [];
      prevPos = simPositions();
    }
    // Düzeltmeyi bir anda değil, birkaç karede yumuşakça uygula
    const after = renderPositions(alpha, true);
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b) continue;
      const o = offsets.get(id) || { x: 0, y: 0 };
      o.x += b.x - a.x;
      o.y += b.y - a.y;
      if (corrStats && Math.hypot(b.x - a.x, b.y - a.y) < 60) {
        const k = id === 'ball' ? 'ball' : id === myId ? 'me' : 'other';
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        corrStats[k].sum += d;
        if (d > 0.5) corrStats[k].n++;
        corrStats[k].max = Math.max(corrStats[k].max, d);
      }
      if (Math.hypot(o.x, o.y) > 60) { o.x = 0; o.y = 0; } // büyük sıçrama (gol, devre): direkt geç
      offsets.set(id, o);
    }
    updateHud();
  }

  // Kareler arası ara konum + düzeltme sapması (HaxBall birimleri)
  function renderPositions(alpha, noOffset) {
    const out = new Map();
    if (!sim) return out;
    const cur = simPositions();
    for (const [id, c] of cur) {
      const p = prevPos.get(id) || c;
      const o = noOffset ? null : offsets.get(id);
      out.set(id, {
        x: p.x + (c.x - p.x) * alpha + (o ? o.x : 0),
        y: p.y + (c.y - p.y) * alpha + (o ? o.y : 0),
      });
    }
    return out;
  }

  function inputDelay() {
    return window.__inputDelay != null ? window.__inputDelay : inputDelayTicks;
  }

  function advanceSim(dt) {
    if (!sim) return;
    const playing = inMatch() && sim.players.has(myId);
    simAcc += dt;
    let steps = 0;
    while (simAcc >= TICK && steps < 6) {
      simAcc -= TICK;
      steps++;
      if (playing) {
        const k = inputBits();
        seq++;
        pending.push([seq, k]);
        send({ t: 'i', s: seq, k });
        const d = inputDelay();
        simStep(pending.length > d ? pending[pending.length - 1 - d][1] : null);
      } else simStep(null);
    }
    if (steps === 6) simAcc = 0; // sekme arka plandaydı: yetişmeye çalışma
    const decay = Math.exp(-dt * 14);
    for (const o of offsets.values()) {
      o.x *= decay;
      o.y *= decay;
    }
  }

  // ---------- F1 yarışı ----------
  const RC = window.RACING, TR = window.TRACK;
  let rsim = null, rmeta = null, racc = 0, rseq = 0, rpending = [], rprev = new Map();
  const roffsets = new Map();
  let rDelay = 2;
  let lightsAt = 0, goAt = 0; // yerel zaman (ışıklar ve start)
  const skids = []; // lastik izleri (yerel görsel efekt)
  let lastRr = null;

  function inRace() {
    return !!lobby.raceRunning && myId != null && (lobby.racers || []).includes(myId);
  }
  function nearTrack() {
    const R = TR.REGION;
    return cam.x + vw > R.x && cam.x < R.x + R.w && cam.y + vh > R.y && cam.y < R.y + R.h;
  }
  function resetRaceView() {
    rsim = null;
    rmeta = null;
    rpending = [];
    roffsets.clear();
    rprev = new Map();
    racc = 0;
  }
  function fmtTime(ticks) {
    const t = ticks / RC.TPS, m = Math.floor(t / 60), sec = t - m * 60;
    return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
  }

  function rPositions() {
    const m = new Map();
    for (const c of rsim.cars.values()) m.set(c.id, { x: c.x, y: c.y, a: c.a });
    return m;
  }
  function rStep(bits) {
    rprev = rPositions();
    if (bits != null) rsim.setInput(myId, bits);
    rsim.step(true);
  }
  // Kareler arası ara konum + düzeltme sapması (yön açısı da ara değerlenir)
  function raceRender(alpha, noOffset) {
    const out = new Map();
    if (!rsim) return out;
    for (const c of rsim.cars.values()) {
      const p = rprev.get(c.id) || c;
      const o = noOffset ? null : roffsets.get(c.id);
      let da = c.a - p.a;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      out.set(c.id, {
        x: p.x + (c.x - p.x) * alpha + (o ? o.x : 0), y: p.y + (c.y - p.y) * alpha + (o ? o.y : 0),
        a: p.a + da * alpha, car: c,
      });
    }
    return out;
  }
  // Futboldaki tahmin sistemiyle aynı: sunucu durumu gelince onaylanmamış girdiler yeniden oynatılır
  function onRaceSnapshot(g) {
    rmeta = g;
    if (!lobby.raceRunning) return;
    if (!rsim) {
      rsim = new RC.Race();
      rsim.load(g);
      rpending = [];
      rprev = rPositions();
      return;
    }
    const alpha = Math.min(1, racc / TICK);
    const before = raceRender(alpha, true);
    rsim.load(g);
    const mine = g.p.find((q) => q[0] === myId);
    if (mine) {
      const ack = mine[15];
      const want = Math.max(2, Math.min(3, mine[16] || 2));
      if (want > rDelay) rDelay++;
      else if (want < rDelay) rDelay--;
      rpending = rpending.filter(([sq]) => sq > ack);
      if (rpending.length > 90) rpending = rpending.slice(-90);
      const upto = Math.max(0, rpending.length - rDelay);
      for (let i = 0; i < upto; i++) rStep(rpending[i][1]);
      if (!upto) rprev = rPositions();
    } else {
      rpending = [];
      rprev = rPositions();
    }
    const after = raceRender(alpha, true);
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b) continue;
      const o = roffsets.get(id) || { x: 0, y: 0 };
      o.x += b.x - a.x;
      o.y += b.y - a.y;
      if (Math.hypot(o.x, o.y) > 80) { o.x = 0; o.y = 0; }
      roffsets.set(id, o);
    }
  }
  function advanceRace(dt) {
    if (!rsim) return;
    const playing = inRace() && rsim.cars.has(myId);
    racc += dt;
    let steps = 0;
    while (racc >= TICK && steps < 6) {
      racc -= TICK;
      steps++;
      if (playing) {
        const k = inputBits() & 15;
        rseq++;
        rpending.push([rseq, k]);
        send({ t: 'ri', s: rseq, k });
        rStep(rpending.length > rDelay ? rpending[rpending.length - 1 - rDelay][1] : null);
      } else rStep(null);
    }
    if (steps === 6) racc = 0;
    const decay = Math.exp(-dt * 12);
    for (const o of roffsets.values()) { o.x *= decay; o.y *= decay; }
  }

  // Sıralama (tarayıcıdaki tahmini duruma göre)
  function raceStandings() {
    if (!rsim) return [];
    const L = TR.LENGTH;
    return [...rsim.cars.values()].sort((a, b) => {
      if (a.finished && b.finished) return a.finished - b.finished;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return ((b.lap - 1) * L + (b.s || 0)) - ((a.lap - 1) * L + (a.s || 0));
    });
  }

  function drawRacePads() {
    if (!inView(TR.PADS.join.x + 250, TR.PADS.join.y, 500)) return;
    const hover = joined && !inMatch() && !inRace() ? me : null;
    const racers = lobby.racers || [];
    const running = !!lobby.raceRunning;
    const names = racers.map((id) => (players.get(id) || {}).name).filter(Boolean);
    const pads = [
      ['join', '#2e7d32', (racers.includes(myId) ? '✓ ' : '') + '🏎️ Yarışa Katıl', names.length ? names : ['(boş — tıkla, katıl)']],
      ['start', running ? '#8a8a8a' : '#f0a93b',
        !running ? '▶ Yarışı Başlat' : isAdmin ? '⏹ Yarışı Bitir' : '🏁 Yarış sürüyor',
        running ? [isAdmin ? 'Yönetici olarak bitir' : 'Sadece yönetici bitirebilir'] : [`${racers.length} pilot hazır · ${RC.LAPS} tur`]],
    ];
    for (const [name, fill, title, lines] of pads) {
      const pad = TR.PADS[name];
      const over = hover && W.inRect(hover.x, hover.y, pad);
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
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '800 16px Nunito, Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('🏁 Istanbul Park · F1', (TR.PADS.join.x + TR.PADS.start.x + TR.PADS.start.w) / 2, TR.PADS.join.y - 8);
  }

  function drawSkids(time) {
    for (let i = skids.length - 1; i >= 0; i--) {
      const k = (time - skids[i][4]) / 5000;
      if (k >= 1) { skids.splice(i, 1); continue; }
      const [x1, y1, x2, y2] = skids[i];
      if (!inView(x1, y1, 20)) continue;
      ctx.strokeStyle = `rgba(20,20,20,${0.28 * (1 - k)})`;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // Üstten F1 aracı: gövde oyuncu renginde, siyah lastikler, ön/arka kanat, kokpit
  function drawCar(d, pl, isMe, time) {
    const c = d.car;
    if (!inView(d.x, d.y, 80)) return;
    const color = pl ? pl.color : '#cfcfcf';
    // Lastik izi: araç yana kayıyorsa
    const fx = Math.cos(d.a), fy = Math.sin(d.a);
    const lat = Math.abs(-c.vx * fy + c.vy * fx);
    if (lat > 0.55 && c.lastSkid) {
      for (const side of [-6.5, 6.5]) {
        const rx = d.x - fx * 8 - fy * side, ry = d.y - fy * 8 + fx * side;
        const px = c.lastSkid.x - fx * 8 - fy * side, py = c.lastSkid.y - fy * 8 + fx * side;
        if (Math.hypot(rx - px, ry - py) < 20) skids.push([px, py, rx, ry, time]);
      }
      if (skids.length > 1500) skids.splice(0, skids.length - 1500);
    }
    c.lastSkid = { x: d.x, y: d.y };

    ctx.save();
    ctx.translate(d.x, d.y);
    // Rüzgar arkası: aracın iki yanında hava çizgileri
    if (c.slip > 0.15) {
      ctx.save();
      ctx.rotate(d.a);
      ctx.strokeStyle = `rgba(255,255,255,${0.25 + 0.35 * c.slip})`;
      ctx.lineWidth = 1.4;
      const ph = (time / 60) % 12;
      for (const yy of [-9, 9]) {
        ctx.beginPath();
        ctx.moveTo(10 - ph, yy);
        ctx.lineTo(-6 - ph, yy);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.save();
    ctx.rotate(d.a);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    roundRect(ctx, -12, -4, 27, 12, 4);
    ctx.fill();
    ctx.fillStyle = '#161616';
    ctx.fillRect(-11.5, -8.6, 6.4, 3.6); // arka lastikler
    ctx.fillRect(-11.5, 5, 6.4, 3.6);
    ctx.fillRect(5, -7.8, 5, 3); // ön lastikler
    ctx.fillRect(5, 4.8, 5, 3);
    ctx.fillStyle = '#262626';
    ctx.fillRect(-14, -6.4, 3.2, 12.8); // arka kanat
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-11.5, -3.2);
    ctx.lineTo(-4, -4.8);
    ctx.lineTo(2.5, -3.6);
    ctx.lineTo(11.5, -1.3);
    ctx.lineTo(13, 0);
    ctx.lineTo(11.5, 1.3);
    ctx.lineTo(2.5, 3.6);
    ctx.lineTo(-4, 4.8);
    ctx.lineTo(-11.5, 3.2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = '#262626';
    ctx.fillRect(11, -6.2, 2.6, 12.4); // ön kanat
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.ellipse(-1, 0, 3.6, 2.2, 0, 0, Math.PI * 2); // kokpit
    ctx.fill();
    ctx.fillStyle = isMe ? '#ffe08a' : '#f5f5f5';
    ctx.beginPath();
    ctx.arc(-1, 0, 1.5, 0, Math.PI * 2); // kask
    ctx.fill();
    ctx.restore();
    // İsim etiketi (dönmez)
    if (pl) {
      const nm = (pl.admin ? '👑 ' : '') + pl.name;
      ctx.font = 'bold 11px Nunito, Trebuchet MS, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(nm, 0, -20);
      ctx.fillStyle = isMe ? '#ffe08a' : '#fff';
      ctx.fillText(nm, 0, -20);
      ctx.save();
      ctx.translate(-6, -22);
      drawSocial(pl, time);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawRace(time, rr) {
    drawRacePads();
    if (!rr) return;
    drawSkids(time);
    for (const [id, d] of rr) if (id !== myId) drawCar(d, players.get(id), false, time);
    const mine = rr.get(myId);
    if (mine) drawCar(mine, players.get(myId), true, time); // kendi aracın en üstte
  }

  // Start ışıkları (5 kırmızı) ve "BAŞLA"
  function drawStartLights() {
    const ph = lobby.raceRunning && rmeta ? rmeta.ph : null;
    if (!(ph === 'grid' || ph === 'lights') || !(inRace() || nearTrack())) return;
    const lit = ph === 'lights' && lightsAt ? Math.min(5, Math.floor((performance.now() - lightsAt) / 1000) + 1) : 0;
    const w = 5 * 46 + 24, x0 = vw / 2 - w / 2, y0 = 70;
    ctx.save();
    ctx.fillStyle = '#1b1b1b';
    roundRect(ctx, x0, y0, w, 64, 12);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.stroke();
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i < lit ? '#ff2a2a' : '#3a0d0d';
      ctx.beginPath();
      ctx.arc(x0 + 12 + 23 + i * 46, y0 + 32, 17, 0, Math.PI * 2);
      ctx.fill();
      if (i < lit) {
        ctx.fillStyle = 'rgba(255,120,120,0.5)';
        ctx.beginPath();
        ctx.arc(x0 + 12 + 18 + i * 46, y0 + 27, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = '#fff';
    ctx.font = '800 14px Nunito, Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ph === 'grid' ? 'Araçlar gridde · ışıkları bekle' : 'Işıklar sönünce gaz!', vw / 2, y0 + 84);
    ctx.restore();
  }

  let raceHudKey = '';
  function updateRaceHud() {
    const hud = $('raceHud');
    const show = lobby.raceRunning && rsim && (inRace() || nearTrack());
    if (!show) {
      if (raceHudKey !== 'off') { hud.classList.add('hidden'); raceHudKey = 'off'; }
      return;
    }
    const st = raceStandings();
    const myCar = rsim.cars.get(myId);
    let key = st.map((c) => c.id + ':' + c.lap).join(',');
    let parts = null;
    if (myCar) {
      const pos = st.indexOf(myCar) + 1;
      const racing = rmeta && (rmeta.ph === 'race' || rmeta.ph === 'finish');
      const cur = racing && myCar.lap > 0 && !myCar.finished ? rsim.tick - myCar.lapStart : 0;
      parts = {
        pos: `P${pos}`, of: `/${st.length}`, lap: `${Math.max(1, Math.min(myCar.lap, RC.LAPS))}/${RC.LAPS}`,
        time: myCar.finished ? 'BİTTİ' : fmtTime(cur), best: myCar.bestLap ? fmtTime(myCar.bestLap) : '—',
        speed: String(RC.kmh(myCar)), slip: myCar.slip > 0.15,
      };
      key += '|' + Object.values(parts).join('|');
    }
    if (key === raceHudKey) return;
    raceHudKey = key;
    hud.classList.remove('hidden');
    $('rMine').classList.toggle('hidden', !parts);
    if (parts) {
      $('rPos').textContent = parts.pos;
      $('rOf').textContent = parts.of;
      $('rLap').textContent = parts.lap;
      $('rTime').textContent = parts.time;
      $('rBest').textContent = parts.best;
      $('rSpeed').textContent = parts.speed;
      $('rSlip').classList.toggle('hidden', !parts.slip);
    }
    const board = $('rBoard');
    board.innerHTML = '';
    st.slice(0, 12).forEach((c, i) => {
      const pl = players.get(c.id);
      const row = document.createElement('div');
      row.className = 'rrow' + (c.id === myId ? ' me' : '');
      const n = document.createElement('b');
      n.textContent = i + 1;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = pl ? pl.color : '#ccc';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = pl ? pl.name : '?';
      const info = document.createElement('span');
      info.className = 'inf';
      info.textContent = c.finished ? '🏁' : `T${Math.max(1, Math.min(c.lap, RC.LAPS))}`;
      row.append(n, dot, nm, info);
      board.appendChild(row);
    });
  }

  let resultsTimer = null;
  function showRaceResults(m) {
    if (!(inRace() || nearTrack() || (m.results || []).some((r) => r.id === myId))) return;
    const box = $('raceResults');
    const list = $('rrList');
    list.innerHTML = '';
    const reason = m.reason === 'empty' ? 'Pistte araç kalmadı' : m.reason === 'time' ? 'Süre doldu' : 'Yarış bitti';
    $('rrTitle').textContent = '🏁 ' + reason;
    m.results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rrrow' + (r.id === myId ? ' me' : '');
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      const cells = [medal, r.name, r.finished ? fmtTime(r.finished) : `DNF (${r.lap}/${RC.LAPS})`, r.best ? 'En iyi ' + fmtTime(r.best) : ''];
      for (const t of cells) {
        const sp = document.createElement('span');
        sp.textContent = t;
        row.appendChild(sp);
      }
      list.appendChild(row);
    });
    box.classList.remove('hidden');
    clearTimeout(resultsTimer);
    resultsTimer = setTimeout(() => box.classList.add('hidden'), 10000);
  }

  // ---------- Sosyal ----------
  function showChat(id, text) {
    const p = players.get(id);
    if (p) p.chat = { text, until: performance.now() + 5000 };
  }
  function showEmote(id, e) {
    const p = players.get(id);
    if (p) p.emote = { e, start: performance.now() };
  }

  let goalTimer = null;
  function announce(text, color, sub) {
    const el = $('goal');
    el.innerHTML = '';
    const t = document.createElement('div');
    t.textContent = text;
    t.style.color = color || '#fff';
    el.appendChild(t);
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      el.appendChild(s);
    }
    el.classList.add('show');
    clearTimeout(goalTimer);
    goalTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  let hudKey = '';
  function updateHud() {
    const el = $('score');
    const g = lobby.running ? meta : null;
    let key = 'off';
    if (g) {
      const left = Math.max(0, H.halfSeconds - Math.floor(g.tk / HB.TPS));
      const mm = String(Math.floor(left / 60)).padStart(2, '0');
      const ss = String(left % 60).padStart(2, '0');
      let msg = '';
      const hasRed = g.p.some((q) => q[1] === 0), hasBlue = g.p.some((q) => q[1] === 1);
      if (hasRed !== hasBlue) msg = `${hasRed ? H.teams.blue.name : H.teams.red.name} takımda oyuncu yok — katılmak için takım alanına tıkla`;
      key = [g.s[0], g.s[1], g.half, mm, ss, msg].join('|');
      if (key !== hudKey) {
        $('sRed').textContent = g.s[0];
        $('sBlue').textContent = g.s[1];
        $('sHalf').textContent = `${g.half}. Devre`;
        $('sTime').textContent = `${mm}:${ss}`;
        $('sMsg').textContent = msg;
        $('sMsg').classList.toggle('hidden', !msg);
      }
    }
    if (key === hudKey) return;
    hudKey = key;
    el.classList.toggle('hidden', !g);
  }

  // ---------- Yönetici ----------
  function setAdmin(v) {
    isAdmin = v;
    document.body.classList.toggle('admin', v);
    $('adminBtn').classList.toggle('hidden', v);
    $('adminTools').classList.toggle('hidden', !v);
    const self = players.get(myId);
    if (self) self.admin = v;
    renderPlayerList();
  }
  function openAdminModal() {
    $('adminErr').textContent = '';
    $('adminPw').value = '';
    $('adminModal').classList.remove('hidden');
    $('adminPw').focus();
  }
  function closeAdminModal(resume) {
    $('adminModal').classList.add('hidden');
    if (resume) requestLock();
  }
  $('adminBtn').onclick = openAdminModal;
  $('adminCancel').onclick = () => closeAdminModal(false);
  $('adminLogin').onclick = () => {
    const pw = $('adminPw').value;
    if (pw) send({ t: 'admin', pw });
  };
  $('adminPw').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') $('adminLogin').click();
    if (e.key === 'Escape') closeAdminModal(false);
  });
  $('admStop').onclick = () => send({ t: 'mod', action: 'stop' });
  $('admStart').onclick = () => send({ t: 'mod', action: 'start' });
  $('admClear').onclick = () => send({ t: 'mod', action: 'clearchat' });
  $('admLogout').onclick = () => {
    store.set('imlec-kampi:yonetici', null);
    send({ t: 'adminLogout' });
    setAdmin(false);
    toast('Yönetici çıkışı yapıldı');
  };

  let openMenu = null;
  function closeMenu() {
    if (openMenu) openMenu.remove();
    openMenu = null;
  }
  document.addEventListener('click', (e) => {
    if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.mod')) closeMenu();
  });

  // Oyuncu satırındaki yönetici butonları: sustur (süre menüsü), izleyiciye al, at (iki tık onay)
  function modButtons(p, team) {
    const box = document.createElement('span');
    box.className = 'mod';
    const btn = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(b); };
      box.appendChild(b);
      return b;
    };
    btn(mutedIds.has(p.id) ? '🔈' : '🔇', mutedIds.has(p.id) ? 'Susturmayı kaldır' : 'Sustur', (b) => {
      if (mutedIds.has(p.id)) return send({ t: 'mod', action: 'unmute', id: p.id });
      closeMenu();
      const menu = document.createElement('div');
      menu.className = 'menu';
      for (const [txt, min] of [['1 dakika', 1], ['5 dakika', 5], ['30 dakika', 30], ['Kalıcı', 0]]) {
        const it = document.createElement('button');
        it.textContent = '🔇 ' + txt;
        it.onclick = (e) => { e.stopPropagation(); send({ t: 'mod', action: 'mute', id: p.id, minutes: min }); closeMenu(); };
        menu.appendChild(it);
      }
      b.closest('.row').appendChild(menu);
      openMenu = menu;
    });
    if (team) btn('👁', 'İzleyiciye al', () => send({ t: 'mod', action: 'spec', id: p.id }));
    btn('👢', 'Siteden at', (b) => {
      // İki tıkla onay (tarayıcı diyaloğu kullanmadan)
      if (b.classList.contains('danger')) return send({ t: 'mod', action: 'kick', id: p.id });
      b.classList.add('danger');
      b.textContent = 'Emin misin?';
      setTimeout(() => { if (b.isConnected) { b.classList.remove('danger'); b.textContent = '👢'; } }, 3000);
    });
    return box;
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
      const team = lobby.red.includes(p.id) ? 'red' : lobby.blue.includes(p.id) ? 'blue' : null;
      dot.style.background = p.color;
      if (team) dot.style.boxShadow = `0 0 0 2px ${H.teams[team].color}`;
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = (p.admin ? '👑 ' : '') + p.name + (p.id === myId ? ' (sen)' : '');
      const g = document.createElement('span');
      g.className = 'goals';
      g.textContent = '⚽ ' + (scores[p.id] || 0);
      row.append(dot, nm);
      if (isAdmin && mutedIds.has(p.id)) {
        const mi = document.createElement('span');
        mi.className = 'muted-ic';
        mi.textContent = '🔇';
        mi.title = 'Susturuldu';
        row.append(mi);
      }
      row.append(g);
      if (isAdmin && p.id !== myId) row.append(modButtons(p, team));
      list.appendChild(row);
    }
  }

  if (location.hostname === 'localhost') {
    // Yerel test kancası
    window.__imlec = {
      me, players, send: (m) => send(m), step: (dt) => stepMovement(dt),
      get sim() { return sim; }, get pending() { return pending; }, keys,
      setLocked: (v) => { locked = v; updateModeUi(); },
      advance: (dt) => advanceSim(dt),
      get rp() { return lastRp; },
      get rr() { return lastRr; }, get rsim() { return rsim; }, get rpending() { return rpending; },
      startStats: () => { corrStats = { ball: { n: 0, sum: 0, max: 0 }, me: { n: 0, sum: 0, max: 0 }, other: { n: 0, sum: 0, max: 0 } }; },
      get stats() { return corrStats; },
      get delay() { return inputDelay(); },
    };
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
  bg.width = W.CAMP_W;
  bg.height = W.CAMP_H;
  (function drawBackground() {
    const c = bg.getContext('2d');
    const r = rng(42);
    // Kum
    c.fillStyle = '#ecd9a4';
    c.fillRect(0, 0, W.CAMP_W, W.CAMP_H);
    for (let i = 0; i < 2600; i++) {
      c.fillStyle = r() < 0.5 ? 'rgba(160,120,60,0.18)' : 'rgba(255,255,255,0.35)';
      c.beginPath();
      c.arc(r() * W.CAMP_W, r() * W.CAMP_H, 1 + r() * 2.2, 0, Math.PI * 2);
      c.fill();
    }
    // Çakıllar
    for (let i = 0; i < 70; i++) {
      const x = r() * W.CAMP_W, y = r() * W.CAMP_H;
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
  const MM_S = 300 / W.W;
  const mm = document.createElement('canvas');
  mm.width = Math.round(W.W * MM_S);
  mm.height = Math.round(W.H * MM_S);
  (function () {
    const c = mm.getContext('2d');
    c.fillStyle = '#ecd9a4';
    c.fillRect(0, 0, mm.width, mm.height);
    c.drawImage(bg, 0, 0, W.CAMP_W * MM_S, W.CAMP_H * MM_S);
    TRACKDRAW.drawMini(c, MM_S);
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
  let lakeGradient = null;
  function drawWater(time) {
    const s = time / 1000;
    // Göl
    const L = W.LAKE;
    const lakeVisible = inView(L.cx, L.cy, Math.max(L.rx, L.ry) + 40);
    if (lakeVisible) {
      if (!lakeGradient) {
        lakeGradient = ctx.createRadialGradient(L.cx, L.cy, 20, L.cx, L.cy, L.rx);
        lakeGradient.addColorStop(0, '#3f9fd8');
        lakeGradient.addColorStop(1, '#6cc3ec');
      }
      ctx.fillStyle = lakeGradient;
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
    }

    // Nehir (kamera nehrin kutusunun dışındaysa çizme)
    if (!inView(1820, 250, 380)) return;
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

  function drawPads(time) {
    if (!inView(1000, 1040, 300)) return;
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
        title = !lobby.running ? '▶ Maçı Başlat' : isAdmin ? '⏹ Maçı Bitir' : '⚽ Maç sürüyor';
        if (lobby.running) lines = isAdmin ? ['Yönetici olarak bitir'] : ['Sadece yönetici bitirebilir'];
        else if (!lobby.red.length || !lobby.blue.length) lines = ['Her takımda en az 1 kişi', `${lobby.red.length} - ${lobby.blue.length}`];
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
    ctx.fillText('Takım alanına tıkla, hazır ol · Başlat’a tıkla, maç başlasın', 1000, 1098);
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
    const label = (p.admin ? '👑 ' : '') + p.name;
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
    if (p.afk) drawZzz(time);
    else if (p.typing && !(p.chat && time < p.chat.until)) drawTyping(time);
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

  // Uzakta: imlecin sağ üstünde yükselen, hafifçe salınan "zZz"
  function drawZzz(time) {
    const t = time / 1000;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const sizes = [15, 21, 30];
    for (let i = 0; i < 3; i++) {
      const x = 26 + i * 15 + Math.sin(t * 1.6 + i) * 1.5;
      const y = -8 - i * 16 + Math.sin(t * 2.2 + i * 1.3) * 2;
      ctx.globalAlpha = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.4 - i * 0.9));
      ctx.font = `900 ${sizes[i]}px Nunito, Trebuchet MS, sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText('z', x, y);
      ctx.fillStyle = '#2f56d6';
      ctx.fillText(i === 2 ? 'Z' : 'z', x, y);
    }
    ctx.restore();
  }

  // Yazıyor: üç noktası zıplayan küçük balon
  function drawTyping(time) {
    const t = time / 1000;
    const bx = 6, by = -38, w = 46, h = 26;
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    roundRect(ctx, bx, by, w, h, 12);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx + 10, by + h - 1);
    ctx.lineTo(bx + 4, by + h + 8);
    ctx.lineTo(bx + 20, by + h - 1);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    for (let i = 0; i < 3; i++) {
      const jump = Math.max(0, Math.sin(t * 7 - i * 0.8)) * 4;
      ctx.globalAlpha = 0.45 + 0.55 * (jump / 4);
      ctx.beginPath();
      ctx.arc(bx + 12 + i * 11, by + h / 2 - jump, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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

  // ---------- Maç çizimi ----------
  function drawMatch(time, rp) {
    const S = H.S;
    const half = sim ? sim.half : 1;
    // Kale çizgisi ve direkler: 2. devrede taraflar değiştiği için canlı çizilir
    for (const team of ['red', 'blue']) {
      const side = (team === 'red' ? -1 : 1) * (half === 2 ? -1 : 1);
      const x0 = H.cx + side * H.ballAreaX * S;
      const c = team === 'red' ? '#ffcccc' : '#ccccff';
      ctx.strokeStyle = c;
      ctx.lineWidth = 3 * S;
      ctx.beginPath();
      ctx.moveTo(x0, H.cy - H.goalY * S);
      ctx.lineTo(x0, H.cy + H.goalY * S);
      ctx.stroke();
      ctx.fillStyle = c;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2 * S;
      for (const t of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(x0, H.cy + t * H.goalY * S, H.postRadius * S, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    let bpos = { x: H.cx, y: H.cy };
    if (rp) {
      for (const [id, d] of rp) {
        if (id === 'ball') continue;
        const q = sim.players.get(id);
        if (!q) continue;
        drawDisc(players.get(id), W.toWorld(d.x, d.y), q, id === myId, time);
      }
      const b = rp.get('ball');
      bpos = W.toWorld(b.x, b.y);
    }
    ball.x = bpos.x;
    ball.y = bpos.y;
    // Top (HaxBall: beyaz disk, siyah kenar)
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2 * S;
    ctx.beginPath();
    ctx.arc(bpos.x, bpos.y, H.ball.radius * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  function drawDisc(pl, d, q, isMe, time) {
    const S = H.S, r = H.player.radius * S;
    ctx.fillStyle = H.teams[q.team].color;
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2 * S;
    ctx.strokeStyle = q.input & HB.INPUT.KICK ? '#fff' : '#000';
    ctx.stroke();
    if (isMe) {
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
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3;
    const nm = (pl.admin ? '👑 ' : '') + pl.name;
    ctx.strokeText(nm, d.x, d.y + r + 12);
    ctx.fillText(nm, d.x, d.y + r + 12);
    ctx.save();
    ctx.translate(d.x - 6, d.y - r + 4);
    drawSocial(pl, time);
    ctx.restore();
  }

  // ---------- Ekran katmanı: geri sayım ve emoji menüsü ----------
  let lastPhase = null;
  function drawOverlay() {
    const ph = lobby.running && meta ? meta.ph : null;
    if (ph !== lastPhase) {
      if (lastPhase === 'countdown' && ph === 'kickoff') announce('BAŞLA!', '#fff', `${meta.half}. Devre`);
      lastPhase = ph;
    }
    if (ph === 'countdown') {
      const n = Math.max(1, Math.ceil(meta.tmr / HB.TPS));
      ctx.save();
      ctx.font = '900 120px Nunito, Trebuchet MS, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 8;
      ctx.strokeStyle = INK;
      ctx.fillStyle = '#fff';
      ctx.strokeText(String(n), vw / 2, vh * 0.4);
      ctx.fillText(String(n), vw / 2, vh * 0.4);
      ctx.font = '800 22px Nunito, Trebuchet MS, sans-serif';
      ctx.lineWidth = 5;
      const sub = `${meta.half}. devre başlıyor`;
      ctx.strokeText(sub, vw / 2, vh * 0.4 + 80);
      ctx.fillText(sub, vw / 2, vh * 0.4 + 80);
      ctx.restore();
    }
    if (radial) drawRadial();
  }

  function drawRadial() {
    const R = 82;
    const sx = me.x - Math.round(cam.x), sy = me.y - Math.round(cam.y); // menü imleci/diski takip eder
    ctx.save();
    ctx.fillStyle = 'rgba(30,24,18,0.55)';
    ctx.beginPath();
    ctx.arc(sx, sy, R + 34, 0, Math.PI * 2);
    ctx.arc(sx, sy, 26, 0, Math.PI * 2, true);
    ctx.fill();
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + i * (Math.PI / 4);
      const x = sx + Math.cos(a) * R, y = sy + Math.sin(a) * R;
      const sel = radial.sel === i;
      ctx.fillStyle = sel ? '#fff8ec' : 'rgba(255,248,236,0.18)';
      ctx.beginPath();
      ctx.arc(x, y, sel ? 30 : 24, 0, Math.PI * 2);
      ctx.fill();
      if (sel) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.font = `${sel ? 34 : 26}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(quick[i], x, y + 2);
    }
    // Seçim yönü
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + radial.vx * 0.25, sy + radial.vy * 0.25);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '700 11px Nunito, Trebuchet MS, sans-serif';
    ctx.fillText('E: düzenle', sx, sy + R + 50);
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

  const camLead = { x: 0, y: 0 };
  function updateCamera(dt) {
    const tx = me.x + camLead.x - vw / 2, ty = me.y + camLead.y - vh / 2;
    const k = cam.init ? 1 - Math.exp(-dt * 5) : 1;
    cam.init = true;
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    const clampAxis = (v, view, size) => (view >= size ? (size - view) / 2 : Math.max(0, Math.min(size - view, v)));
    cam.x = clampAxis(cam.x, vw, W.W);
    cam.y = clampAxis(cam.y, vh, W.H);
  }

  let lastRp = null;
  let last = performance.now();
  function frame(time) {
    const dt = Math.min(0.1, (time - last) / 1000);
    last = time;
    advanceSim(dt);
    advanceRace(dt);
    const rp = sim ? renderPositions(Math.min(1, simAcc / TICK)) : null;
    lastRp = rp;
    const rr = rsim ? raceRender(Math.min(1, racc / TICK)) : null;
    lastRr = rr;
    const myDisc = inMatch() && rp ? rp.get(myId) : null;
    const myCar = inRace() && rr ? rr.get(myId) : null;
    camLead.x *= 0.9;
    camLead.y *= 0.9;
    if (myDisc) {
      // Maçtayken "imleç" kendi diskindir; kamera onu takip eder
      const w = W.toWorld(myDisc.x, myDisc.y);
      me.x = w.x;
      me.y = w.y;
      me.vx = me.vy = 0;
      inAx = inAy = 0;
    } else if (myCar) {
      // Yarışırken "imleç" kendi aracındır; kamera gidiş yönüne biraz ileriden bakar
      me.x = myCar.x;
      me.y = myCar.y;
      me.vx = me.vy = 0;
      inAx = inAy = 0;
      camLead.x = myCar.car.vx * 22;
      camLead.y = myCar.car.vy * 22;
    } else if (joined && !inMatch() && !inRace()) stepMovement(dt);
    updateCamera(dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ecd9a4';
    ctx.fillRect(0, 0, vw, vh);
    ctx.save();
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));
    const sx = Math.max(0, Math.floor(cam.x)), sy = Math.max(0, Math.floor(cam.y));
    const sw = Math.min(W.CAMP_W - sx, Math.ceil(vw) + 2), sh = Math.min(W.CAMP_H - sy, Math.ceil(vh) + 2);
    if (sw > 0 && sh > 0) ctx.drawImage(bg, sx, sy, sw, sh, sx, sy, sw, sh);
    if (nearTrack()) TRACKDRAW.draw(ctx, cam.x, cam.y, vw, vh);
    else if (joined) TRACKDRAW.prefetch(TR.PADS.join.x - vw / 2, TR.PADS.join.y - vh / 2);
    drawWater(time);
    drawPads(time);
    drawMatch(time, rp);
    drawRace(time, rr);

    const rt = time - INTERP_DELAY;
    for (const p of players.values()) {
      if (p.id === myId) continue;
      p.render = interp(p.snaps, rt);
      if (p.render && !(sim && sim.players.has(p.id)) && !(rr && rr.has(p.id)) && inView(p.render.x, p.render.y, 200)) {
        drawCursor(p, p.render.x, p.render.y, time, false);
      }
    }
    if (joined && !myDisc && !myCar) {
      const self = players.get(myId) || { name: me.name, color: me.color };
      drawCursor(self, me.x, me.y, time, true);
    }
    ctx.restore();
    if (joined) drawMinimap();
    drawOverlay();
    drawStartLights();
    updateHud();
    updateRaceHud();
    requestAnimationFrame(frame);
  }

  function inView(x, y, m) {
    return x > cam.x - m && x < cam.x + vw + m && y > cam.y - m && y < cam.y + vh + m;
  }

  requestAnimationFrame(frame);
})();
