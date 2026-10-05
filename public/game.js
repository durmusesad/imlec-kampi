(() => {
  'use strict';
  const W = window.WORLD;
  const HB = window.HAXBALL;
  const H = W.HAX;
  const INK = '#3b2f24';
  const INTERP_DELAY = 100; // ms — diğer imleçler bu kadar geriden çizilir
  const SEND_EVERY = 33; // ms (~30 Hz)
  const TICK = 1 / HB.TPS;
  const BOT_PADS = W.botPadList(window.TRACK); // "+ Bot / − Bot" kutuları (sunucuyla aynı sıra)
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
  // Yarışta kamera yakınlaşır. wvw/wvh: dünyada görünen alanın boyutu (ekran / zoom)
  let zoom = 1, wvw = innerWidth, wvh = innerHeight;
  const RACE_ZOOM = 1.6;
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
  // Skin seçici: sayfalar (sekmeler) ve her sayfada skin önizlemeleri
  const SK = window.SKINS;
  me.skin = saved.skin && SK.LIST.some((s) => s.id === saved.skin) ? saved.skin : SK.PAGES[0].skins[Math.floor(Math.random() * 8)].id;
  me.color = SK.labelColor(me.skin);
  let skinPage = Math.max(0, SK.PAGES.findIndex((pg) => pg.skins.some((s) => s.id === me.skin)));
  const skinPreviewCache = {};
  function renderSkinPicker() {
    const tabs = $('skinTabs'), grid = $('skinGrid');
    tabs.innerHTML = '';
    SK.PAGES.forEach((pg, i) => {
      const b = document.createElement('button');
      b.textContent = pg.name;
      b.className = i === skinPage ? 'sel' : '';
      b.onclick = () => { skinPage = i; renderSkinPicker(); };
      tabs.appendChild(b);
    });
    grid.innerHTML = '';
    for (const s of SK.PAGES[skinPage].skins) {
      const b = document.createElement('button');
      b.className = 'skin' + (s.id === me.skin ? ' sel' : '');
      b.title = s.name;
      const cv = document.createElement('canvas');
      cv.width = cv.height = 96;
      const c = cv.getContext('2d');
      c.scale(2, 2);
      c.translate(s.kind === 'emoji' ? 9 : 15, s.kind === 'emoji' ? 9 : 10);
      c.scale(1.25, 1.25);
      SK.draw(c, s.id, 0);
      // Kanvası resme çevir: bulanık arka planlı giriş ekranında kanvaslar her tarayıcıda görünmeyebiliyor
      const img = document.createElement('img');
      img.src = skinPreviewCache[s.id] || (skinPreviewCache[s.id] = cv.toDataURL());
      img.alt = s.name;
      b.appendChild(img);
      b.onclick = () => {
        me.skin = s.id;
        me.color = SK.labelColor(s.id);
        $('skinName').textContent = s.name;
        renderSkinPicker();
      };
      grid.appendChild(b);
    }
    $('skinName').textContent = SK.get(me.skin).name;
  }
  renderSkinPicker();
  nameInput.focus();
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('joinBtn').onclick = doJoin;

  function doJoin() {
    const name = nameInput.value.trim().slice(0, 16);
    if (!name) { nameInput.focus(); return; }
    me.name = name;
    SFX.init(); // tarayıcı sesi ancak bir tıklama/tuşla başlatmaya izin verir
    store.set('imlec-kampi:oyuncu', { name, skin: me.skin });
    joined = true;
    $('join').classList.add('hidden');
    ['players', 'keys', 'chatlog', 'ping', 'soundBtn'].forEach((id) => $(id).classList.remove('hidden'));
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
      mouseBits = 0;
      closeChat();
    }
    updateModeUi();
  });
  document.addEventListener('pointerlockerror', updateModeUi);
  canvas.addEventListener('dblclick', () => {
    if (joined && !locked) requestLock();
    SFX.init();
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
    if (inVb()) {
      // Voleybolda fare yerdeki nişanı gezdirir
      aim.x = Math.max(-VB.boundX - 100, Math.min(VB.boundX + 100, aim.x + e.movementX / (zoom * VB.S)));
      aim.y = Math.max(-VB.boundY - 80, Math.min(VB.boundY + 80, aim.y + e.movementY / (zoom * VB.S)));
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
    if (watching) return; // izlerken imleç ekranda değil; alanlara/menüye tıklanmasın
    if (inVb()) {
      // Voleybol: sol tık pas, sağ tık smaç (emoji menüsü yerine; emojiler 1–8 ile)
      if (e.button === 0) mouseBits |= 16;
      else if (e.button === 2) mouseBits |= 32;
      return;
    }
    if (e.button === 2) {
      radial = { vx: 0, vy: 0, sel: -1 };
      return;
    }
    if (e.button !== 0) return;
    if (radial) {
      pickRadial();
      return;
    }
    if (inMatch() || inRace() || inHk() || inTank()) return;
    // Sol tık sadece etkileşimli alanlarda bir şey yapar (boş yere tıklamak hiçbir şey göndermez)
    for (let i = 0; i < BOT_PADS.length; i++) {
      if (W.inRect(me.x, me.y, BOT_PADS[i].r)) {
        SFX.click();
        send({ t: 'bot', i });
        return;
      }
    }
    for (const [name, pad] of Object.entries(W.PADS)) {
      if (W.inRect(me.x, me.y, pad)) {
        SFX.click();
        send({ t: 'pad', pad: name });
        return;
      }
    }
    for (const [name, pad] of Object.entries(TR.PADS)) {
      if (W.inRect(me.x, me.y, pad)) {
        SFX.click();
        send({ t: 'rpad', pad: name });
        return;
      }
    }
    for (const [name, pad] of Object.entries(W.VPADS)) {
      if (W.inRect(me.x, me.y, pad)) {
        SFX.click();
        send({ t: 'vpad', pad: name });
        return;
      }
    }
    for (const [name, pad] of Object.entries(W.HPADS)) {
      if (W.inRect(me.x, me.y, pad)) {
        SFX.click();
        send({ t: 'hpad', pad: name });
        return;
      }
    }
    for (const [name, pad] of Object.entries(W.TPADS)) {
      if (W.inRect(me.x, me.y, pad)) {
        SFX.click();
        send({ t: 'tpad', pad: name });
        return;
      }
    }
    for (const [name, pad] of Object.entries(BJP)) {
      if (W.inRect(me.x, me.y, pad)) {
        SFX.click();
        send({ t: 'bpad', pad: name });
        return;
      }
    }
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouseBits &= ~16;
    if (e.button === 2) mouseBits &= ~32;
    if (e.button === 2 && radial) pickRadial();
  });
  function pickRadial() {
    if (radial && radial.sel >= 0) sendEmote(quick[radial.sel]);
    radial = null;
  }
  function sendEmote(em) {
    send({ t: 'emote', e: em });
    showEmote(myId, em);
    SFX.pop(1, 0);
  }

  // ---------- Klavye ----------
  const KEYMAP = {
    KeyW: 1, ArrowUp: 1, KeyS: 2, ArrowDown: 2, KeyA: 4, ArrowLeft: 4, KeyD: 8, ArrowRight: 8, Space: 16, KeyX: 16,
    ShiftLeft: 64, ShiftRight: 64, // voleybolda balıklama
    KeyF: 128, // tankta mayın
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
    if (inVb()) k |= mouseBits;
    return k;
  }
  document.addEventListener('keyup', (e) => keys.delete(e.code));
  // Sekme/pencere arka plana geçince tuşları bırak ve sunucuya hemen bildir
  function releaseAll() {
    keys.clear();
    mouseBits = 0;
    if (inVb() && vsim) {
      vseq++;
      vpending.push([vseq, 0, aim.x, aim.y]);
      send({ t: 'vi', s: vseq, k: 0, ax: aim.x, ay: aim.y });
    }
    if (inMatch() && sim) {
      seq++;
      pending.push([seq, 0]);
      send({ t: 'i', s: seq, k: 0 });
    }
    if (inTank() && tsim) {
      tseq++;
      tpending.push([tseq, 0]);
      send({ t: 'ti', s: tseq, k: 0 });
    }
    if (inHk() && hsim) {
      hseq++;
      hpending.push([hseq, 0]);
      send({ t: 'hi', s: hseq, k: 0 });
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
    const playing = inMatch() || inRace() || inVb() || inHk() || inTank();
    if (KEYMAP[e.code] && playing) {
      e.preventDefault();
      keys.add(e.code);
      return;
    }
    if (e.repeat) return;
    if (bjMyTurn() && (e.code === 'Space' || e.code === 'KeyW' || e.code === 'KeyS')) {
      e.preventDefault();
      bjSend(e.code === 'KeyS' ? 'stand' : 'hit');
      return;
    }
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
        if (myTeam() || myVTeam() || myHTeam() || (lobby.tankers || []).includes(myId) || (lobby.racers || []).includes(myId) || inBj()) send({ t: 'leave' });
        return;
      case 'KeyE':
        openEmojiPanel();
        return;
      case 'KeyH':
        flashKeys();
        return;
      case 'KeyM':
        toggleSound();
        return;
      case 'KeyV':
        cycleWatch();
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
      ws.send(JSON.stringify({ t: 'join', name: me.name, skin: me.skin, x: me.x, y: me.y, token, adminKey: store.get('imlec-kampi:yonetici', null) }));
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
      id: p.id, name: p.name, color: p.color, skin: p.skin,
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
        if (watching) send({ t: 'watch', g: watching }); // yeniden bağlanınca izlemeye devam
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
        const wasIn = inMatch(), wasRace = inRace(), wasVb = inVb(), wasHk = inHk(), wasTk = inTank();
        lobby = m;
        document.body.classList.toggle('in-match', inMatch());
        document.body.classList.toggle('in-race', inRace());
        document.body.classList.toggle('in-vb', inVb());
        document.body.classList.toggle('in-hk', inHk());
        document.body.classList.toggle('in-tank', inTank());
        if (!m.running) resetMatchView();
        if (!m.raceRunning) resetRaceView();
        if (!m.vRunning) resetVView();
        if (!m.hRunning) resetHView();
        if (!m.tRunning) resetTView();
        if (!wasVb && inVb()) resetAim();
        if (wasIn !== inMatch() || wasRace !== inRace() || wasVb !== inVb() || wasHk !== inHk() || wasTk !== inTank()) {
          keys.clear(); // sadece kendi durumum değişince; başkası takım değiştirince tuşlarım bırakılmasın
        }
        renderPlayerList();
        updateHud();
        break;
      }
      case 'g':
        lastSnapAt = now;
        onSnapshot(m);
        break;
      case 'pong': {
        // Gidiş-dönüş süresi; ani sıçramalar göstergeyi titretmesin diye yumuşatılır
        const rtt = now - m.c;
        if (rtt >= 0 && rtt < 10000) rttMs = rttMs == null ? rtt : rttMs * 0.6 + rtt * 0.4;
        lastPongAt = now;
        updatePing();
        break;
      }
      case 'rg':
        lastSnapAt = now;
        onRaceSnapshot(m);
        break;
      case 'vg':
        lastSnapAt = now;
        onVSnapshot(m);
        break;
      case 'hg':
        lastSnapAt = now;
        onHSnapshot(m);
        break;
      case 'tg':
        lastSnapAt = now;
        onTSnapshot(m);
        break;
      case 'bj':
        onBj(m);
        break;
      case 'bjres':
        onBjResult(m);
        break;
      case 'tkill':
        explode(W.TK.x + m.x, W.TK.y + m.y, m.how === 'mine');
        if (m.id === myId) toast(m.by === myId ? (m.how === 'mine' ? '💥 Kendi mayınına bastın' : '💥 Kendi merminle vuruldun') : `💥 ${(players.get(m.by) || {}).name || 'Biri'} seni vurdu`);
        break;
      case 'tboom':
        explode(W.TK.x + m.x, W.TK.y + m.y, true);
        break;
      case 'tround': {
        scores = m.scores || scores;
        renderPlayerList();
        if (!(inTank() || nearArena())) break;
        const p = m.winner != null ? players.get(m.winner) : null;
        if (p) announce(`${p.name} turu kazandı!`, p.color, '+1 puan');
        else announce('Kimse kalmadı', '#fff', 'Bu tur puan yok');
        if (m.winner === myId) SFX.goal();
        break;
      }
      case 'tend': {
        if (!(inTank() || nearArena())) break;
        const top = m.standings && m.standings[0];
        announce('Tank maçı bitti', '#fff', top ? `Lider: ${top.name} (${top.s})` : '');
        break;
      }
      case 'hgoal': {
        scores = m.scores || scores;
        renderPlayerList();
        if (!(inHk() || nearRink())) break;
        const p = m.by != null ? players.get(m.by) : null;
        const team = W.HK.teams[m.team];
        const who = p ? (m.own ? `${p.name} (kendi kalesine)` : p.name) : team.name;
        announce(`🏒 GOL! ${who}`, team.color, `${m.score.red} - ${m.score.blue}`);
        SFX.goal();
        break;
      }
      case 'hperiod':
        if (inHk() || nearRink()) {
          announce(`${m.period}. PERİYOT`, '#fff', 'Taraflar değişiyor');
          SFX.whistle('half');
        }
        break;
      case 'hend': {
        if (!(inHk() || nearRink())) break;
        const t = m.winner ? W.HK.teams[m.winner] : null;
        if (m.reason === 'empty') announce('Maç bitti', '#fff', 'Tüm oyuncular sahadan ayrıldı');
        else {
          announce(t ? `${t.name} kazandı!` : 'Berabere!', t ? t.color : '#fff', `${m.score.red} - ${m.score.blue}`);
          SFX.whistle('end');
        }
        break;
      }
      case 'vpoint': {
        scores = m.scores || scores;
        renderPlayerList();
        if (!(inVb() || nearCourt())) break;
        const t = W.VB.teams[m.team];
        const p = m.by != null ? players.get(m.by) : null;
        const why = { in: p ? `${p.name} sahaya indirdi` : 'Top sahaya düştü', out: 'Dışarı!', double: 'Çift dokunuş', touches: '4. dokunuş' }[m.reason] || '';
        announce(`${t.name} sayı`, t.color, `${why} · ${m.score.red} - ${m.score.blue}`);
        SFX.whistle('start');
        break;
      }
      case 'vend': {
        if (!(inVb() || nearCourt())) break;
        const t = m.winner ? W.VB.teams[m.winner] : null;
        if (m.reason === 'empty') announce('Maç bitti', '#fff', 'Tüm oyuncular sahadan ayrıldı');
        else {
          announce(t ? `${t.name} kazandı!` : 'Berabere!', t ? t.color : '#fff', `${m.score.red} - ${m.score.blue}`);
          SFX.whistle('end');
          SFX.goal();
        }
        break;
      }
      case 'rlights':
        lightsAt = performance.now();
        goAt = 0;
        break;
      case 'rgo':
        goAt = performance.now();
        if (inRace() || nearTrack()) SFX.go();
        if (inRace() || nearTrack()) announce('BAŞLA!', '#fff', 'Istanbul Park · ' + RC.LAPS + ' tur');
        break;
      case 'rlap':
        if (m.id === myId) { toast(`Tur ${m.lap} bitti · ${fmtTime(m.time)}`); SFX.lap(); }
        break;
      case 'rfinish': {
        const p = players.get(m.id);
        if (m.id === myId) { announce(`${m.pos}. oldun!`, '#fff', fmtTime(m.time)); SFX.finish(); }
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
        if (inMatch() || nearField()) SFX.whistle('half');
        break;
      case 'end': {
        const t = m.winner ? H.teams[m.winner] : null;
        const sub = m.reason === 'empty' ? 'Tüm oyuncular sahadan ayrıldı' : `${m.score.red} - ${m.score.blue}`;
        if (m.reason !== 'empty' && (inMatch() || nearField())) SFX.whistle('end');
        if (m.reason === 'empty') announce('Maç bitti', '#fff', sub);
        else announce(t ? `${t.name} kazandı!` : 'Berabere!', t ? t.color : '#fff', sub);
        break;
      }
      case 'chat':
        showChat(m.id, m.text);
        addChatLine(m);
        SFX.chat();
        break;
      case 'emote': {
        showEmote(m.id, m.e);
        const p = players.get(m.id);
        const sp = p && p.render ? spatial(p.render.x, p.render.y) : null;
        if (sp) SFX.pop(sp.vol, sp.pan);
        break;
      }
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
        if (inMatch() || nearField()) SFX.goal();
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
        ballSoundStep(() => simStep(pending.length > d ? pending[pending.length - 1 - d][1] : null));
      } else ballSoundStep(() => simStep(null));
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
    return cam.x + wvw > R.x && cam.x < R.x + R.w && cam.y + wvh > R.y && cam.y < R.y + R.h;
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
        crashSoundStep(() => rStep(rpending.length > rDelay ? rpending[rpending.length - 1 - rDelay][1] : null));
      } else crashSoundStep(() => rStep(null));
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
    const color = pl ? SK.get(pl.skin).color : '#cfcfcf';
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
  let lastLit = 0;
  function drawStartLights() {
    const ph = lobby.raceRunning && rmeta ? rmeta.ph : null;
    if (!(ph === 'grid' || ph === 'lights') || !(inRace() || nearTrack())) { lastLit = 0; return; }
    const lit = ph === 'lights' && lightsAt ? Math.min(5, Math.floor((performance.now() - lightsAt) / 1000) + 1) : 0;
    if (lit > lastLit) SFX.beep();
    lastLit = lit;
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
    $('rrTitle').textContent = m.reason === 'empty' ? '🏁 Yarış sona erdi' : '🏁 Yarış sonuçları';
    $('rrSub').textContent = m.reason === 'empty' ? 'Tüm pilotlar yarıştan ayrıldı' : m.reason === 'time' ? 'Süre doldu' : '';
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

  // ---------- Plaj voleybolu ----------
  const VO = window.VOLLEY, VB = W.VB;
  let vsim = null, vmeta = null, vacc = 0, vseq = 0, vpending = [], vprev = new Map();
  const voffsets = new Map();
  let vDelay = 2;
  const aim = { x: VB.courtX / 2, y: 0 }; // fare nişanı (voleybol birimi)
  let mouseBits = 0; // sol tık = pas, sağ tık = smaç (voleybolda)

  function inVb() {
    return !!lobby.vRunning && myId != null && ((lobby.vred || []).includes(myId) || (lobby.vblue || []).includes(myId));
  }
  function myVTeam() {
    return (lobby.vred || []).includes(myId) ? 'red' : (lobby.vblue || []).includes(myId) ? 'blue' : null;
  }
  function nearCourt() {
    const F = W.VFIELD, m = 200;
    return cam.x + wvw > F.x - m && cam.x < F.x + F.w + m && cam.y + wvh > F.y - m && cam.y < F.y + F.h + m;
  }
  function resetVView() {
    vsim = null;
    vmeta = null;
    vpending = [];
    voffsets.clear();
    vprev = new Map();
    vacc = 0;
  }
  function resetAim() {
    aim.x = myVTeam() === 'blue' ? -VB.courtX / 2 : VB.courtX / 2;
    aim.y = 0;
  }

  function vPositions() {
    const m = new Map();
    for (const p of vsim.players.values()) m.set(p.id, { x: p.x, y: p.y, z: 0 });
    const b = vsim.ball;
    m.set('ball', { x: b.x, y: b.y, z: b.z });
    return m;
  }
  function vStep(entry) {
    vprev = vPositions();
    if (entry) vsim.setInput(myId, entry[1], entry[2], entry[3]);
    return vsim.step(true);
  }
  function vRender(alpha, noOffset) {
    const out = new Map();
    if (!vsim) return out;
    for (const [id, c] of vPositions()) {
      const p = vprev.get(id) || c;
      const o = noOffset ? null : voffsets.get(id);
      out.set(id, {
        x: p.x + (c.x - p.x) * alpha + (o ? o.x : 0),
        y: p.y + (c.y - p.y) * alpha + (o ? o.y : 0),
        z: p.z + (c.z - p.z) * alpha + (o ? o.z : 0),
      });
    }
    return out;
  }
  // Futbol/yarıştaki tahmin sistemiyle aynı; girdiyle birlikte nişan da yeniden oynatılır
  function onVSnapshot(g) {
    vmeta = g;
    if (!lobby.vRunning) return;
    if (!vsim) {
      vsim = new VO.VMatch();
      vsim.load(g);
      vpending = [];
      vprev = vPositions();
      return;
    }
    const alpha = Math.min(1, vacc / TICK);
    const before = vRender(alpha, true);
    vsim.load(g);
    const mine = g.p.find((q) => q[0] === myId);
    if (mine) {
      const ack = mine[10];
      const want = Math.max(2, Math.min(3, mine[11] || 2));
      if (want > vDelay) vDelay++;
      else if (want < vDelay) vDelay--;
      vpending = vpending.filter(([s]) => s > ack);
      if (vpending.length > 90) vpending = vpending.slice(-90);
      const upto = Math.max(0, vpending.length - vDelay);
      for (let i = 0; i < upto; i++) vStep(vpending[i]);
      if (!upto) vprev = vPositions();
    } else {
      vpending = [];
      vprev = vPositions();
    }
    const after = vRender(alpha, true);
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b) continue;
      const o = voffsets.get(id) || { x: 0, y: 0, z: 0 };
      o.x += b.x - a.x;
      o.y += b.y - a.y;
      o.z += b.z - a.z;
      if (Math.hypot(o.x, o.y, o.z) > 60) { o.x = 0; o.y = 0; o.z = 0; }
      voffsets.set(id, o);
    }
  }
  function advanceV(dt) {
    if (!vsim) return;
    const playing = inVb() && vsim.players.has(myId);
    vacc += dt;
    let steps = 0;
    while (vacc >= TICK && steps < 6) {
      vacc -= TICK;
      steps++;
      const bz = vsim.ball.z;
      let ev;
      if (playing) {
        const k = inputBits();
        vseq++;
        const e = [vseq, k, Math.round(aim.x * 10) / 10, Math.round(aim.y * 10) / 10];
        vpending.push(e);
        send({ t: 'vi', s: vseq, k, ax: e[2], ay: e[3] });
        ev = vStep(vpending.length > vDelay ? vpending[vpending.length - 1 - vDelay] : null);
      } else ev = vStep(null);
      vSounds(ev, bz);
    }
    if (steps === 6) vacc = 0;
    const decay = Math.exp(-dt * 14);
    for (const o of voffsets.values()) { o.x *= decay; o.y *= decay; o.z *= decay; }
  }

  // Voleybol sesleri (tahmin adımlarından; düzeltme tekrarları ses çıkarmaz)
  const vSndAt = {};
  function vSounds(ev, bzBefore) {
    const b = vsim.ball, w = W.vbToWorld(b.x, b.y), sp = spatial(w.x, w.y);
    if (!sp) return;
    const t = performance.now();
    const once = (k, ms) => { if (t - (vSndAt[k] || 0) < ms) return false; vSndAt[k] = t; return true; };
    for (const e of ev) if (e.type === 'net' && once('net', 300)) SFX.netHit(sp.vol, sp.pan);
    if (bzBefore > 0 && b.z === 0 && once('land', 300)) SFX.sand(sp.vol, sp.pan);
  }
  // Vuruş sesi: son dokunuş (oyuncu + an) değişince bir kez. Tahminden de sunucu durumundan da gelse
  // aynı dokunuş iki kez çalınmaz (tahmin ile sunucunun anı birkaç tick farklı olabilir)
  let vHitSnd = { id: null, tick: 0 };
  function vHitSound() {
    if (!vsim) return;
    const li = vsim.lastId, lt = vsim.lastTick;
    if (li == null || !lt || (li === vHitSnd.id && Math.abs(lt - vHitSnd.tick) <= 15)) return;
    vHitSnd = { id: li, tick: lt };
    if (vsim.tick - lt > 20) return; // eski dokunuş (sayfaya yeni gelindi)
    const b = vsim.ball, w = W.vbToWorld(b.x, b.y), sp = spatial(w.x, w.y);
    if (!sp) return;
    const hs = Math.hypot(b.vx, b.vy);
    if (hs > 8.5) SFX.spike(sp.vol, sp.pan);
    else if (hs > 5.5) SFX.kick(sp.vol * 0.9, sp.pan);
    else if (hs < 2.2 && b.vz < 3.3) SFX.touch(sp.vol * 0.8, sp.pan);
    else SFX.bump(sp.vol, sp.pan);
  }

  // Alan kutusu (futbol/yarış alanlarıyla aynı görünüm)
  function padBox(pad, fill, title, lines, over) {
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

  function drawVPads() {
    const P = W.VPADS;
    if (!inView(P.start.x + 100, P.start.y, 500)) return;
    const hover = joined && !inMatch() && !inRace() && !inVb() ? me : null;
    const running = !!lobby.vRunning;
    for (const [name, pad] of Object.entries(P)) {
      let fill, title, lines;
      if (name !== 'start') {
        const t = VB.teams[name];
        const ids = lobby['v' + name] || [];
        fill = t.color;
        title = (ids.includes(myId) ? '✓ ' : '') + `🏐 ${t.name}`;
        lines = ids.map((id) => (players.get(id) || {}).name).filter(Boolean);
        if (!lines.length) lines = ['(boş — tıkla, katıl)'];
      } else {
        const r = (lobby.vred || []).length, b = (lobby.vblue || []).length;
        fill = running ? '#8a8a8a' : '#f0a93b';
        title = !running ? '▶ Voleybolu Başlat' : isAdmin ? '⏹ Maçı Bitir' : '🏐 Maç sürüyor';
        if (running) lines = [isAdmin ? 'Yönetici olarak bitir' : 'Sadece yönetici bitirebilir'];
        else if (!r || !b) lines = ['Her takımda en az 1 kişi', `${r} - ${b}`];
        else lines = [`${r} - ${b} oyuncu hazır · ${VB.winScore} sayı`];
        if (!running && lobby.vLast) lines.push(`Son maç: ${lobby.vLast.score.red}-${lobby.vLast.score.blue}`);
      }
      padBox(pad, fill, title, lines, hover && W.inRect(hover.x, hover.y, pad));
    }
    ctx.fillStyle = 'rgba(59,47,36,0.75)';
    ctx.font = '600 14px Nunito, Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('🏐 Plaj Voleybolu · fareyle nişan al · sol tık pas · sağ tık smaç · Shift balıklama', VB.cx, P.start.y + P.start.h + 58);
  }

  // Kort: sadece çizgiler ve file (zemin kumsalın kendisi)
  function drawCourt() {
    const S = VB.S, cx = VB.cx, cy = VB.cy;
    const X = VB.courtX * S, Y = VB.courtY * S, A = VB.attackLine * S;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 5;
    ctx.strokeRect(cx - X, cy - Y, X * 2, Y * 2);
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 10]);
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * A, cy - Y);
      ctx.lineTo(cx + s * A, cy + Y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // File: gölgesi, ağ dokusu, üst bant ve direkler
    const N = VB.netHalf * S, sh = VB.netH * S * 0.35;
    ctx.fillStyle = 'rgba(40,30,20,0.18)';
    ctx.beginPath();
    ctx.moveTo(cx - 2, cy - N);
    ctx.lineTo(cx + sh, cy - N + sh * 0.6);
    ctx.lineTo(cx + sh, cy + N + sh * 0.6);
    ctx.lineTo(cx - 2, cy + N);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(30,30,30,0.55)';
    ctx.fillRect(cx - 4, cy - N, 8, N * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = cy - N; y <= cy + N; y += 8) { ctx.moveTo(cx - 4, y); ctx.lineTo(cx + 4, y); }
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - N);
    ctx.lineTo(cx, cy + N);
    ctx.stroke();
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#4a4a4a';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy + s * (N + 6), 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // Sapma elipsi: vuruş yönünde uzun, ileriye kaymış
  function drawSpread(bx, by, tx, ty, sp, color) {
    const S = VB.S;
    const a = Math.atan2(ty - by, tx - bx);
    const w = W.vbToWorld(tx, ty);
    ctx.save();
    ctx.translate(w.x, w.y);
    ctx.rotate(a);
    ctx.translate(sp.bias * sp.along * S, 0);
    ctx.fillStyle = color.replace('A', '0.13');
    ctx.strokeStyle = color.replace('A', '0.85');
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(4, sp.along * S), Math.max(4, sp.lat * S), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawVolley(time, vp) {
    if (!inView(VB.cx, VB.cy, 1000)) return;
    drawCourt();
    drawVPads();
    if (!vp || !vsim) return;
    const S = VB.S;
    const b = vp.get('ball');
    const bw = W.vbToWorld(b.x, b.y);
    // Topun ineceği yer (hafif işaret)
    const L = vsim.phase === 'play' && vsim.ball.z > 0 ? VO.landing(vsim.ball) : null;
    if (L) {
      const lw = W.vbToWorld(L.x, L.y);
      ctx.strokeStyle = 'rgba(59,47,36,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lw.x, lw.y, 8, 0, Math.PI * 2);
      ctx.moveTo(lw.x - 5, lw.y - 5); ctx.lineTo(lw.x + 5, lw.y + 5);
      ctx.moveTo(lw.x + 5, lw.y - 5); ctx.lineTo(lw.x - 5, lw.y + 5);
      ctx.stroke();
    }
    // Kendi nişanım ve sapma alanları
    const q = inVb() ? vsim.players.get(myId) : null;
    if (q) {
      const ball = vsim.ball;
      const serving = vsim.phase === 'serve' && vsim.server === myId;
      const first = vsim.lastTeam !== q.team;
      const dist = Math.hypot(aim.x - ball.x, aim.y - ball.y);
      const base = { speed: Math.hypot(q.vx, q.vy), incoming: first && !serving ? Math.hypot(ball.vx, ball.vy, ball.vz) : 0 };
      const passKind = serving ? 'serve' : 'pass';
      const canSp = !serving && vsim.canSpike({ ...q, ax: aim.x }, Math.max(ball.z, VO.WINDOW.spike.min));
      drawSpread(ball.x, ball.y, aim.x, aim.y, VO.spread(passKind, dist, base), 'rgba(255,255,255,A)');
      // Smaç alanı sadece smaç atılabilecekken görünür (sert vuruş kaldırıldı)
      if (canSp) drawSpread(ball.x, ball.y, aim.x, aim.y, VO.spread('spike', dist, { ...base, goodSet: vsim.goodSet }), 'rgba(255,80,40,A)');
      const aw = W.vbToWorld(aim.x, aim.y), mw = W.vbToWorld(q.x, q.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(mw.x, mw.y);
      ctx.lineTo(aw.x, aw.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(aw.x, aw.y, 9, 0, Math.PI * 2);
      ctx.moveTo(aw.x - 15, aw.y); ctx.lineTo(aw.x - 5, aw.y);
      ctx.moveTo(aw.x + 5, aw.y); ctx.lineTo(aw.x + 15, aw.y);
      ctx.moveTo(aw.x, aw.y - 15); ctx.lineTo(aw.x, aw.y - 5);
      ctx.moveTo(aw.x, aw.y + 5); ctx.lineTo(aw.x, aw.y + 15);
      ctx.stroke();
      ctx.font = '800 12px Nunito, Trebuchet MS, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      const label = serving ? 'servis: sol tık / Space' : canSp ? 'SMAÇ hazır (sağ tık)' : '';
      if (label) {
        ctx.strokeText(label, aw.x + 18, aw.y - 14);
        ctx.fillStyle = canSp ? '#ff9a7a' : '#fff';
        ctx.fillText(label, aw.x + 18, aw.y - 14);
      }
      // Vuruş menzili: her zaman silik halka; gölge menzile girince renklenir (yeşil = ideal an)
      const d = Math.hypot(ball.x - q.x, ball.y - q.y);
      const me2 = vp.get(myId);
      const dw = W.vbToWorld(me2.x, me2.y);
      const inReach = !serving && vsim.phase === 'play' && d <= VO.REACH && ball.z <= VO.WINDOW.spike.max;
      ctx.lineWidth = inReach ? 3.5 : 1.5;
      if (inReach) {
        const kind = canSp && ball.z >= VO.WINDOW.spike.min ? 'spike' : 'pass';
        const te = VO.timingErr(kind, ball.z);
        ctx.strokeStyle = te === 0 ? '#43d17a' : te < 0.5 ? '#f5c542' : '#ff5252';
      } else ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.arc(dw.x, dw.y, (VO.REACH - VB.ball.radius) * S, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Oyuncular
    for (const [id, d] of vp) {
      if (id === 'ball') continue;
      const pq = vsim.players.get(id);
      if (!pq) continue;
      const dw = W.vbToWorld(d.x, d.y);
      if (pq.dashT > VO.DASH.recover) {
        // Balıklama izi
        ctx.fillStyle = 'rgba(236,217,164,0.9)';
        ctx.strokeStyle = 'rgba(160,130,80,0.5)';
        for (let i = 1; i <= 3; i++) {
          ctx.beginPath();
          ctx.arc(dw.x - pq.vx * S * i * 2.2, dw.y - pq.vy * S * i * 2.2, 6 - i, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
      if (pq.dashT > 0 && !vDashSnd.has(id)) {
        vDashSnd.add(id);
        const sp = spatial(dw.x, dw.y);
        if (sp) SFX.dash(sp.vol, sp.pan);
      } else if (pq.dashT === 0) vDashSnd.delete(id);
      if (id === myId && pq.dashCd > 0) {
        // Balıklama bekleme süresi: diskin çevresinde dolan yay
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(dw.x, dw.y, VB.player.radius * S + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - pq.dashCd / VO.DASH.cooldown));
        ctx.stroke();
      }
      drawDisc(players.get(id), W.vbToWorld(d.x, d.y), pq, id === myId, time);
    }
    // Top: yerde gölge, yükseldikçe yukarı kayar ve büyür
    const z = Math.max(0, b.z);
    ctx.fillStyle = `rgba(40,30,20,${0.35 * Math.max(0.25, 1 - z / 220)})`;
    ctx.beginPath();
    ctx.ellipse(bw.x, bw.y, VB.ball.radius * S * (1 - Math.min(0.5, z / 300)), VB.ball.radius * S * 0.6 * (1 - Math.min(0.5, z / 300)), 0, 0, Math.PI * 2);
    ctx.fill();
    const r = VB.ball.radius * S * (1 + z / 160);
    const by = bw.y - z * S * 0.8;
    if (z > 4) {
      // Top ile gölgesi arasında ince çizgi: topun gerçek yeri gölgedir
      ctx.strokeStyle = 'rgba(40,30,20,0.25)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(bw.x, bw.y);
      ctx.lineTo(bw.x, by + r);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.save();
    ctx.translate(bw.x, by);
    ctx.rotate((vsim.tick / 8) % (Math.PI * 2));
    ctx.fillStyle = '#ffe066';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = '#2f6fdd';
    ctx.lineWidth = r * 0.45;
    for (const k of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(k * r * 1.2, 0, r * 1.05, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawVOverlay() {
    if (!(lobby.vRunning && vmeta && vmeta.ph === 'countdown' && (inVb() || nearCourt()))) { lastVCount = 0; return; }
    const n = Math.max(1, Math.ceil(vmeta.tmr / VO.TPS));
    if (n !== lastVCount) SFX.beep();
    lastVCount = n;
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
    ctx.strokeText('Voleybol başlıyor', vw / 2, vh * 0.4 + 80);
    ctx.fillText('Voleybol başlıyor', vw / 2, vh * 0.4 + 80);
    ctx.restore();
  }
  let lastVCount = 0, lastVPhase = null;
  const vDashSnd = new Set();

  let vHudKey = '';
  function updateVHud() {
    const el = $('vscore');
    const g = lobby.vRunning && vsim && (inVb() || nearCourt()) ? vsim : null;
    let key = 'off';
    if (g) {
      const sv = players.get(g.server);
      const touch = g.phase === 'play' && g.lastTeam ? `${VB.teams[g.lastTeam].name} ${g.touches}/3 dokunuş` : '';
      const info = g.phase === 'serve' ? `Servis: ${sv ? sv.name : '—'}` : touch;
      key = [g.score.red, g.score.blue, g.serveTeam, info].join('|');
      if (key !== vHudKey) {
        $('vRed').textContent = g.score.red;
        $('vBlue').textContent = g.score.blue;
        $('vRed').classList.toggle('srv', g.serveTeam === 'red');
        $('vBlue').classList.toggle('srv', g.serveTeam === 'blue');
        $('vInfo').textContent = info || `${VB.winScore} sayıda biter · 2 fark`;
      }
    }
    document.body.classList.toggle('both-scores', !!g && !$('score').classList.contains('hidden'));
    if (key === vHudKey) return;
    vHudKey = key;
    el.classList.toggle('hidden', !g);
  }

  // ---------- Buz hokeyi ----------
  // Futboldaki tahmin sistemiyle aynı: istemci aynı fiziği çalıştırır, sunucu durumu gelince düzeltir
  const HO = window.HOCKEY, HK = W.HK;
  let hsim = null, hmeta = null, hacc = 0, hseq = 0, hpending = [], hprev = new Map();
  const hoffsets = new Map();
  let hDelay = 2;
  const trails = new Map(); // oyuncu id -> paten izi noktaları (dünya koordinatı)

  function inHk() {
    return !!lobby.hRunning && myId != null && ((lobby.hred || []).includes(myId) || (lobby.hblue || []).includes(myId));
  }
  function myHTeam() {
    return (lobby.hred || []).includes(myId) ? 'red' : (lobby.hblue || []).includes(myId) ? 'blue' : null;
  }
  function nearRink() {
    const F = W.HFIELD, m = 200;
    return cam.x + wvw > F.x - m && cam.x < F.x + F.w + m && cam.y + wvh > F.y - m && cam.y < F.y + F.h + m;
  }
  function resetHView() {
    hsim = null;
    hmeta = null;
    hpending = [];
    hoffsets.clear();
    hprev = new Map();
    hacc = 0;
    trails.clear();
  }
  function hPositions() {
    const m = new Map();
    for (const p of hsim.players.values()) m.set(p.id, { x: p.x, y: p.y });
    m.set('puck', { x: hsim.puck.x, y: hsim.puck.y });
    return m;
  }
  function hStep(bits) {
    hprev = hPositions();
    if (bits != null) hsim.setInput(myId, bits);
    hsim.step(true);
  }
  function hRender(alpha, noOffset) {
    const out = new Map();
    if (!hsim) return out;
    for (const [id, c] of hPositions()) {
      const p = hprev.get(id) || c;
      const o = noOffset ? null : hoffsets.get(id);
      out.set(id, {
        x: p.x + (c.x - p.x) * alpha + (o ? o.x : 0),
        y: p.y + (c.y - p.y) * alpha + (o ? o.y : 0),
      });
    }
    return out;
  }
  function onHSnapshot(g) {
    hmeta = g;
    if (!lobby.hRunning) return;
    if (!hsim) {
      hsim = new HO.HMatch();
      hsim.load(g);
      hpending = [];
      hprev = hPositions();
      return;
    }
    const alpha = Math.min(1, hacc / TICK);
    const before = hRender(alpha, true);
    hsim.load(g);
    const mine = g.p.find((q) => q[0] === myId);
    if (mine) {
      const ack = mine[8];
      const want = Math.max(2, Math.min(3, mine[9] || 2));
      if (want > hDelay) hDelay++;
      else if (want < hDelay) hDelay--;
      hpending = hpending.filter(([s]) => s > ack);
      if (hpending.length > 90) hpending = hpending.slice(-90);
      const upto = Math.max(0, hpending.length - hDelay);
      for (let i = 0; i < upto; i++) hStep(hpending[i][1]);
      if (!upto) hprev = hPositions();
    } else {
      hpending = [];
      hprev = hPositions();
    }
    const after = hRender(alpha, true);
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b) continue;
      const o = hoffsets.get(id) || { x: 0, y: 0 };
      o.x += b.x - a.x;
      o.y += b.y - a.y;
      if (Math.hypot(o.x, o.y) > 60) { o.x = 0; o.y = 0; }
      hoffsets.set(id, o);
    }
  }
  function advanceH(dt) {
    if (!hsim) return;
    const playing = inHk() && hsim.players.has(myId);
    hacc += dt;
    let steps = 0;
    while (hacc >= TICK && steps < 6) {
      hacc -= TICK;
      steps++;
      if (playing) {
        const k = inputBits();
        hseq++;
        hpending.push([hseq, k]);
        send({ t: 'hi', s: hseq, k });
        puckSoundStep(() => hStep(hpending.length > hDelay ? hpending[hpending.length - 1 - hDelay][1] : null));
      } else puckSoundStep(() => hStep(null));
    }
    if (steps === 6) hacc = 0;
    const decay = Math.exp(-dt * 14);
    for (const o of hoffsets.values()) { o.x *= decay; o.y *= decay; }
  }

  // Pak sesleri: şut, bant, direk, sopa/paten teması
  let lastPuckSnd = 0, lastShotSnd = 0;
  function puckSoundStep(step) {
    const b = hsim.puck, vx0 = b.vx, vy0 = b.vy;
    const ready = new Map();
    for (const p of hsim.players.values()) ready.set(p.id, p.kickReady);
    step();
    const dv = Math.hypot(b.vx - vx0, b.vy - vy0);
    if (dv < 0.4) return;
    const t = performance.now();
    let shot = false;
    for (const p of hsim.players.values()) if (ready.get(p.id) && !p.kickReady) shot = true;
    if (shot ? t - lastShotSnd < 150 : t - lastPuckSnd < 70) return;
    const w = W.hkToWorld(b.x, b.y), sp = spatial(w.x, w.y);
    if (!sp) return;
    lastPuckSnd = t;
    if (shot) {
      lastShotSnd = t;
      SFX.kick(sp.vol * Math.min(1, 0.6 + dv / 10), sp.pan);
      return;
    }
    const k = sp.vol * Math.min(1, dv / 4);
    for (const sx of [-HK.goalX, HK.goalX]) for (const sy of [-HK.goalW, HK.goalW]) {
      if (Math.hypot(b.x - sx, b.y - sy) < HK.puck.radius + HK.postRadius + 2) { SFX.post(k, sp.pan); return; }
    }
    if (Math.abs(b.x) > HK.goalX && Math.abs(b.x) < HK.goalX + HK.goalD + 6 && Math.abs(b.y) < HK.goalW + 6) { SFX.net(k, sp.pan); return; }
    for (const p of hsim.players.values()) {
      if (Math.hypot(b.x - p.x, b.y - p.y) < p.radius + HK.puck.radius + 3) { SFX.touch(k, sp.pan); return; }
    }
    SFX.post(k * 0.7, sp.pan); // bant
  }

  // Saha zemini (bir kez çizilir)
  const RINK_PAD = 30;
  const rinkCanvas = (function () {
    const S = HK.S, F = W.HFIELD;
    const cv = document.createElement('canvas');
    cv.width = F.w + RINK_PAD * 2;
    cv.height = F.h + RINK_PAD * 2;
    const c = cv.getContext('2d');
    const ox = F.w / 2 + RINK_PAD, oy = F.h / 2 + RINK_PAD;
    const X = (x) => ox + x * S, Y = (y) => oy + y * S;
    const rinkPath = (grow) => roundRect(c, X(-HK.rinkX) - grow, Y(-HK.rinkY) - grow, F.w + grow * 2, F.h + grow * 2, HK.cornerR * S + grow);
    // Bantlar
    c.fillStyle = INK;
    rinkPath(16);
    c.fill();
    c.fillStyle = '#f4f1ea';
    rinkPath(11);
    c.fill();
    c.fillStyle = '#d6c34a';
    rinkPath(4);
    c.fill();
    // Buz
    const g = c.createLinearGradient(0, Y(-HK.rinkY), 0, Y(HK.rinkY));
    g.addColorStop(0, '#eef9ff');
    g.addColorStop(1, '#d4eefa');
    c.fillStyle = g;
    rinkPath(0);
    c.fill();
    c.save();
    rinkPath(0);
    c.clip();
    // Buz parlaması ve çizikleri
    const r = rng(77);
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 1.5;
    for (let i = 0; i < 90; i++) {
      const x = r() * cv.width, y = r() * cv.height, a = r() * Math.PI;
      c.beginPath();
      c.arc(x, y, 40 + r() * 140, a, a + 0.3 + r() * 0.6);
      c.stroke();
    }
    c.strokeStyle = 'rgba(120,170,200,0.12)';
    for (let i = 0; i < 60; i++) {
      const x = r() * cv.width, y = r() * cv.height, a = r() * Math.PI;
      c.beginPath();
      c.arc(x, y, 30 + r() * 100, a, a + 0.3 + r() * 0.5);
      c.stroke();
    }
    // Orta kırmızı çizgi, mavi çizgiler, kale çizgileri
    c.fillStyle = 'rgba(214,52,52,0.75)';
    c.fillRect(X(0) - 4, Y(-HK.rinkY), 8, F.h);
    c.fillStyle = 'rgba(42,98,214,0.7)';
    for (const s of [-1, 1]) c.fillRect(X(s * HK.blueLine) - 6, Y(-HK.rinkY), 12, F.h);
    c.fillStyle = 'rgba(214,52,52,0.6)';
    for (const s of [-1, 1]) c.fillRect(X(s * HK.goalX) - 1.5, Y(-HK.rinkY), 3, F.h);
    // Orta daire ve başlama noktası
    c.strokeStyle = 'rgba(42,98,214,0.7)';
    c.lineWidth = 3;
    c.beginPath();
    c.arc(X(0), Y(0), HK.faceoffRadius * S, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = 'rgba(42,98,214,0.85)';
    c.beginPath();
    c.arc(X(0), Y(0), 6, 0, Math.PI * 2);
    c.fill();
    // Bölge daireleri
    c.strokeStyle = 'rgba(214,52,52,0.55)';
    for (const s of [-1, 1]) for (const t of [-1, 1]) {
      const fx = s * (HK.goalX - 90), fy = t * 100;
      c.beginPath();
      c.arc(X(fx), Y(fy), 45 * S, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = 'rgba(214,52,52,0.7)';
      c.beginPath();
      c.arc(X(fx), Y(fy), 5, 0, Math.PI * 2);
      c.fill();
    }
    // Kale önü (mavi yarım daire)
    for (const s of [-1, 1]) {
      c.fillStyle = 'rgba(90,170,240,0.35)';
      c.strokeStyle = 'rgba(214,52,52,0.6)';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(X(s * HK.goalX), Y(0), 48 * S, s < 0 ? -Math.PI / 2 : Math.PI / 2, s < 0 ? Math.PI / 2 : Math.PI * 1.5);
      c.closePath();
      c.fill();
      c.stroke();
    }
    c.restore();
    return cv;
  })();

  function drawHPads() {
    const P = W.HPADS;
    if (!inView(P.start.x + 100, P.start.y, 500)) return;
    const hover = joined && !inMatch() && !inRace() && !inVb() && !inHk() ? me : null;
    const running = !!lobby.hRunning;
    for (const [name, pad] of Object.entries(P)) {
      let fill, title, lines;
      if (name !== 'start') {
        const t = HK.teams[name];
        const ids = lobby['h' + name] || [];
        fill = t.color;
        title = (ids.includes(myId) ? '✓ ' : '') + `🏒 ${t.name}`;
        lines = ids.map((id) => (players.get(id) || {}).name).filter(Boolean);
        if (!lines.length) lines = ['(boş — tıkla, katıl)'];
      } else {
        const r = (lobby.hred || []).length, b = (lobby.hblue || []).length;
        fill = running ? '#8a8a8a' : '#f0a93b';
        title = !running ? '▶ Hokeyi Başlat' : isAdmin ? '⏹ Maçı Bitir' : '🏒 Maç sürüyor';
        if (running) lines = [isAdmin ? 'Yönetici olarak bitir' : 'Sadece yönetici bitirebilir'];
        else if (!r || !b) lines = ['Her takımda en az 1 kişi', `${r} - ${b}`];
        else lines = [`${r} - ${b} oyuncu hazır · ${HK.periods}×${HK.periodSeconds} sn`];
        if (!running && lobby.hLast) lines.push(`Son maç: ${lobby.hLast.score.red}-${lobby.hLast.score.blue}`);
      }
      padBox(pad, fill, title, lines, hover && W.inRect(hover.x, hover.y, pad));
    }
    ctx.fillStyle = 'rgba(59,47,36,0.75)';
    ctx.font = '600 14px Nunito, Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('🏒 Buz Hokeyi · yön tuşlarıyla kay · Space şut · kalenin arkasından dolanabilirsin', HK.cx, P.start.y + P.start.h + 58);
  }

  // Paten izleri: kayan oyuncunun arkasında kısa süre kalan ince çizgiler
  function updateTrails(hp, time) {
    for (const [id, d] of hp) {
      if (id === 'puck') continue;
      const q = hsim.players.get(id);
      if (!q) continue;
      let tr = trails.get(id);
      if (!tr) trails.set(id, (tr = []));
      const w = W.hkToWorld(d.x, d.y);
      const lastP = tr[tr.length - 1];
      if (!lastP || Math.hypot(w.x - lastP.x, w.y - lastP.y) > 6) tr.push({ x: w.x, y: w.y, t: time });
      while (tr.length && time - tr[0].t > 1600) tr.shift();
    }
    for (const id of [...trails.keys()]) if (!hp.has(id)) trails.delete(id);
  }
  function drawTrails(time) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    for (const tr of trails.values()) {
      for (let i = 1; i < tr.length; i++) {
        const a = tr[i - 1], b = tr[i];
        if (Math.hypot(b.x - a.x, b.y - a.y) > 60) continue; // ışınlanma (gol sonrası)
        const k = 1 - (time - b.t) / 1600;
        if (k <= 0) continue;
        ctx.strokeStyle = `rgba(150,190,215,${0.55 * k})`;
        const nx = -(b.y - a.y), ny = b.x - a.x, nl = Math.hypot(nx, ny) || 1;
        for (const s of [-5, 5]) {
          ctx.beginPath();
          ctx.moveTo(a.x + (nx / nl) * s, a.y + (ny / nl) * s);
          ctx.lineTo(b.x + (nx / nl) * s, b.y + (ny / nl) * s);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawNet(side, team) {
    const S = HK.S;
    const x0 = HK.cx + side * HK.goalX * S, x1 = HK.cx + side * (HK.goalX + HK.goalD) * S;
    const y0 = HK.cy - HK.goalW * S, y1 = HK.cy + HK.goalW * S;
    ctx.save();
    // Ağ
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(Math.min(x0, x1), y0, Math.abs(x1 - x0), y1 - y0);
    ctx.strokeStyle = 'rgba(80,80,80,0.35)';
    ctx.lineWidth = 1;
    for (let y = y0 + 6; y < y1; y += 6) {
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }
    for (let k = 1; k < 5; k++) {
      const x = x0 + ((x1 - x0) * k) / 5;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
    }
    // Çerçeve (takım rengi)
    ctx.strokeStyle = HK.teams[team].color;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x0, y1);
    ctx.stroke();
    ctx.fillStyle = '#c62828';
    for (const y of [y0, y1]) {
      ctx.beginPath();
      ctx.arc(x0, y, HK.postRadius * S + 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  let puckPos = null; // mini harita için
  function drawHockey(time, hp) {
    if (!inView(HK.cx, HK.cy, 1300)) return;
    const F = W.HFIELD;
    ctx.drawImage(rinkCanvas, F.x - RINK_PAD, F.y - RINK_PAD);
    drawHPads();
    const per = hsim ? hsim.period : 1;
    for (const team of ['red', 'blue']) {
      const side = (team === 'red' ? -1 : 1) * (per % 2 === 0 ? -1 : 1);
      drawNet(side, team);
    }
    if (!hp || !hsim) return;
    updateTrails(hp, time);
    drawTrails(time);
    const S = HK.S;
    // Pak: küçük siyah disk, hafif gölge
    const b = hp.get('puck');
    const bw = W.hkToWorld(b.x, b.y);
    puckPos = bw;
    for (const [id, d] of hp) {
      if (id === 'puck') continue;
      const q = hsim.players.get(id);
      if (!q) continue;
      drawDisc(players.get(id), W.hkToWorld(d.x, d.y), q, id === myId, time, HK.player.radius * S, HK.teams);
    }
    ctx.fillStyle = 'rgba(40,60,80,0.25)';
    ctx.beginPath();
    ctx.ellipse(bw.x + 2, bw.y + 3, HK.puck.radius * S, HK.puck.radius * S * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(bw.x, bw.y, HK.puck.radius * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(bw.x, bw.y, HK.puck.radius * S - 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  let lastHPhase = null, lastHCount = 0;
  function drawHOverlay() {
    const ph = lobby.hRunning && hmeta ? hmeta.ph : null;
    const near = inHk() || nearRink();
    if (ph !== lastHPhase) {
      if (lastHPhase === 'countdown' && ph === 'faceoff' && near) {
        announce('BAŞLA!', '#fff', `${hmeta.per}. Periyot`);
        SFX.whistle('start');
      }
      lastHPhase = ph;
    }
    if (ph !== 'countdown' || !near) { lastHCount = 0; return; }
    const n = Math.max(1, Math.ceil(hmeta.tmr / HO.TPS));
    if (n !== lastHCount) SFX.beep();
    lastHCount = n;
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
    const sub = `${hmeta.per}. periyot başlıyor`;
    ctx.strokeText(sub, vw / 2, vh * 0.4 + 80);
    ctx.fillText(sub, vw / 2, vh * 0.4 + 80);
    ctx.restore();
  }

  let hHudKey = '';
  function updateHHud() {
    const g = lobby.hRunning && hmeta && (inHk() || nearRink()) ? hmeta : null;
    let key = 'off';
    if (g) {
      const left = Math.max(0, HK.periodSeconds - Math.floor(g.tk / HO.TPS));
      const mm = String(Math.floor(left / 60)).padStart(2, '0');
      const ss = String(left % 60).padStart(2, '0');
      key = [g.s[0], g.s[1], g.per, mm, ss].join('|');
      if (key !== hHudKey) {
        $('hRed').textContent = g.s[0];
        $('hBlue').textContent = g.s[1];
        $('hPer').textContent = `${g.per}. Periyot`;
        $('hTime').textContent = `${mm}:${ss}`;
      }
    }
    if (key === hHudKey) return;
    hHudKey = key;
    $('hscore').classList.toggle('hidden', !g);
  }

  // ---------- Tank (AZ Tank benzeri) ----------
  // Futbol/hokey ile aynı tahmin sistemi; mayınlar sunucudan sadece sahibine gelir
  const TA = window.TANKS, TK = W.TK;
  let tsim = null, tmeta = null, tacc = 0, tseq = 0, tpending = [], tprev = new Map();
  const toffsets = new Map();
  let tDelay = 2;
  const booms = []; // patlama parçacıkları (yerel görsel efekt)

  function inTank() {
    return !!lobby.tRunning && myId != null && (lobby.tankers || []).includes(myId);
  }
  function nearArena() {
    const F = W.TFIELD, m = 200;
    return cam.x + wvw > F.x - m && cam.x < F.x + F.w + m && cam.y + wvh > F.y - m && cam.y < F.y + F.h + m;
  }
  function resetTView() {
    tsim = null;
    tmeta = null;
    tpending = [];
    toffsets.clear();
    tprev = new Map();
    tacc = 0;
  }
  function tPositions() {
    const m = new Map();
    for (const t of tsim.players.values()) m.set(t.id, { x: t.x, y: t.y, a: t.a });
    for (const b of tsim.bullets) m.set('b' + b.id, { x: b.x, y: b.y, a: 0 });
    return m;
  }
  function tStep(bits) {
    tprev = tPositions();
    if (bits != null) tsim.setInput(myId, bits);
    return tsim.step(true);
  }
  const angLerp = (a, b, k) => {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * k;
  };
  function tRender(alpha, noOffset) {
    const out = new Map();
    if (!tsim) return out;
    for (const [id, c] of tPositions()) {
      const p = tprev.get(id) || c;
      const o = noOffset ? null : toffsets.get(id);
      // Sekme anında ara konum duvarın içine düşmesin: büyük yön değişiminde doğrudan güncel konum
      const jump = Math.hypot(c.x - p.x, c.y - p.y) > 30;
      out.set(id, {
        x: (jump ? c.x : p.x + (c.x - p.x) * alpha) + (o ? o.x : 0),
        y: (jump ? c.y : p.y + (c.y - p.y) * alpha) + (o ? o.y : 0),
        a: angLerp(p.a, c.a, alpha),
      });
    }
    return out;
  }
  function onTSnapshot(g) {
    tmeta = g;
    if (!lobby.tRunning) return;
    if (!tsim) {
      tsim = new TA.TMatch(g.seed);
      tsim.load(g, myId);
      tpending = [];
      tprev = tPositions();
      return;
    }
    const alpha = Math.min(1, tacc / TICK);
    const before = tRender(alpha, true);
    const oldRound = tsim.round;
    tsim.load(g, myId);
    const mine = g.tk.find((q) => q[0] === myId);
    if (mine && g.rd === oldRound) {
      const ack = mine[9];
      const want = Math.max(2, Math.min(3, mine[10] || 2));
      if (want > tDelay) tDelay++;
      else if (want < tDelay) tDelay--;
      tpending = tpending.filter(([s]) => s > ack);
      if (tpending.length > 90) tpending = tpending.slice(-90);
      const upto = Math.max(0, tpending.length - tDelay);
      for (let i = 0; i < upto; i++) tStep(tpending[i][1]);
      if (!upto) tprev = tPositions();
    } else {
      tpending = [];
      tprev = tPositions();
    }
    const after = tRender(alpha, true);
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b || typeof id === 'string') continue; // mermiler düzeltmesiz (sekmede yanlış yöne kaymasın)
      const o = toffsets.get(id) || { x: 0, y: 0 };
      o.x += b.x - a.x;
      o.y += b.y - a.y;
      if (Math.hypot(o.x, o.y) > 40) { o.x = 0; o.y = 0; }
      toffsets.set(id, o);
    }
  }
  let lastRic = 0;
  function advanceT(dt) {
    if (!tsim) return;
    const playing = inTank() && tsim.players.has(myId);
    tacc += dt;
    let steps = 0;
    while (tacc >= TICK && steps < 6) {
      tacc -= TICK;
      steps++;
      let ev;
      if (playing) {
        const k = inputBits();
        tseq++;
        tpending.push([tseq, k]);
        send({ t: 'ti', s: tseq, k });
        ev = tStep(tpending.length > tDelay ? tpending[tpending.length - 1 - tDelay][1] : null);
      } else ev = tStep(null);
      // Sesler (tahmin adımlarından)
      for (const e of ev) {
        if (e.type === 'fire') {
          const t = tsim.players.get(e.id), sp = t && spatial(TK.x + t.x, TK.y + t.y, 1.4);
          if (sp) SFX.tankFire(e.id === myId ? 1 : sp.vol, sp.pan);
        } else if (e.type === 'bounce') {
          const now = performance.now();
          if (now - lastRic < 60) continue;
          const sp = spatial(TK.x + e.x, TK.y + e.y, 1.4);
          if (sp) { lastRic = now; SFX.ricochet(sp.vol, sp.pan); }
        } else if (e.type === 'mine' && e.id === myId) SFX.minePlant();
      }
    }
    if (steps === 6) tacc = 0;
    const decay = Math.exp(-dt * 14);
    for (const o of toffsets.values()) { o.x *= decay; o.y *= decay; }
  }

  // Patlama: kıvılcım + duman parçacıkları
  function explode(x, y, big) {
    const n = big ? 46 : 30;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (big ? 1.5 : 1) * (0.6 + Math.random() * 3.2);
      booms.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 30 + Math.random() * 35,
        r: 3 + Math.random() * (big ? 9 : 6), smoke: Math.random() < 0.45 });
    }
    const sp = spatial(x, y, 1.6);
    if (sp) SFX.boom(sp.vol, sp.pan);
  }
  function drawBooms(dt) {
    const f = dt * 60;
    for (let i = booms.length - 1; i >= 0; i--) {
      const p = booms[i];
      p.life += f;
      if (p.life >= p.max) { booms.splice(i, 1); continue; }
      p.x += p.vx * f;
      p.y += p.vy * f;
      p.vx *= Math.pow(0.92, f);
      p.vy *= Math.pow(0.92, f);
      const k = 1 - p.life / p.max;
      ctx.globalAlpha = k;
      ctx.fillStyle = p.smoke ? '#5a5048' : k > 0.6 ? '#ffe28a' : k > 0.3 ? '#ff9a3c' : '#d9481c';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (p.smoke ? 1.6 - k * 0.6 : 0.5 + k * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Labirent + çamur (tur başına bir kez çizilir)
  let arenaCache = null;
  function arenaCanvas(map) {
    if (arenaCache && arenaCache.seed === map.seed) return arenaCache.cv;
    const pad = 20, cv = document.createElement('canvas');
    cv.width = TK.w + pad * 2;
    cv.height = TK.h + pad * 2;
    const c = cv.getContext('2d');
    c.translate(pad, pad);
    // Hafif koyu kum: arena sınırı belli olsun
    c.fillStyle = 'rgba(160,120,60,0.10)';
    c.fillRect(0, 0, TK.w, TK.h);
    // Çamur (kamptaki çamurla aynı renkler)
    for (const m of map.mud) {
      const r = TA.rng(m.seed);
      c.fillStyle = '#8a6a4a';
      c.beginPath();
      c.ellipse(m.cx, m.cy, m.rx + 6, m.ry + 6, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#7a5b3d';
      c.beginPath();
      c.ellipse(m.cx, m.cy, m.rx, m.ry, 0, 0, Math.PI * 2);
      c.fill();
      for (let i = 0; i < 14; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.85;
        c.fillStyle = r() < 0.5 ? '#6a4c30' : '#94734f';
        c.beginPath();
        c.ellipse(m.cx + Math.cos(a) * m.rx * d, m.cy + Math.sin(a) * m.ry * d, 5 + r() * 12, 3 + r() * 7, r() * 3, 0, Math.PI * 2);
        c.fill();
      }
    }
    // Duvarlar: gölge, gövde, üst ışık
    c.fillStyle = 'rgba(59,47,36,0.35)';
    for (const w of map.walls) c.fillRect(w.x + 3, w.y + 4, w.w, w.h);
    c.fillStyle = INK;
    for (const w of map.walls) c.fillRect(w.x - 1.5, w.y - 1.5, w.w + 3, w.h + 3);
    c.fillStyle = '#6b5440';
    for (const w of map.walls) c.fillRect(w.x, w.y, w.w, w.h);
    c.fillStyle = 'rgba(255,255,255,0.18)';
    for (const w of map.walls) c.fillRect(w.x, w.y, w.w, Math.min(2.5, w.h));
    arenaCache = { seed: map.seed, cv };
    return cv;
  }
  const demoMap = TA.buildMap(20261004); // maç yokken alanda görünen labirent

  function drawTPads() {
    const P = W.TPADS;
    if (!inView(P.join.x + 250, P.join.y, 500)) return;
    const hover = joined && !inMatch() && !inRace() && !inVb() && !inHk() && !inTank() ? me : null;
    const ids = lobby.tankers || [], running = !!lobby.tRunning;
    const names = ids.map((id) => (players.get(id) || {}).name).filter(Boolean);
    padBox(P.join, '#7b5e3b', (ids.includes(myId) ? '✓ ' : '') + '🪖 Tanka Katıl', names.length ? names : ['(boş — tıkla, katıl)'],
      hover && W.inRect(hover.x, hover.y, P.join));
    let lines;
    if (running) lines = [isAdmin ? 'Yönetici olarak bitir' : 'Sadece yönetici bitirebilir'];
    else if (ids.length < 2) lines = ['En az 2 tank (bot da olur)', `${ids.length} tank hazır`];
    else lines = [`${ids.length} tank hazır · süre yok`];
    if (!running && lobby.tLast && lobby.tLast.length) lines.push(`Son: ${lobby.tLast[0].name} ${lobby.tLast[0].s}`);
    padBox(P.start, running ? '#8a8a8a' : '#f0a93b', !running ? '▶ Tankı Başlat' : isAdmin ? '⏹ Maçı Bitir' : '🪖 Maç sürüyor', lines,
      hover && W.inRect(hover.x, hover.y, P.start));
    ctx.fillStyle = 'rgba(59,47,36,0.75)';
    ctx.font = '600 14px Nunito, Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('🪖 Tank · W/S git · A/D dön · Space ateş (5 mermi, duvardan seker) · F basılı tut: mayın (3 sn)', TK.x + TK.w / 2, P.join.y + P.join.h + 58);
  }

  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  function drawTank(t, d, time) {
    const pl = players.get(t.id);
    const col = pl && /^#[0-9a-f]{6}$/i.test(pl.color) ? pl.color : '#7a8f5a';
    const x = TK.x + d.x, y = TK.y + d.y;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(TK.tankR / 15, TK.tankR / 15); // çizim 15 px yarıçapa göre
    if (!t.alive) {
      // Enkaz
      ctx.rotate(d.a);
      ctx.fillStyle = '#3a3530';
      roundRect(ctx, -14, -11, 28, 22, 4);
      ctx.fill();
      ctx.fillStyle = '#1e1b18';
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = `rgba(80,72,64,${0.25 + 0.15 * Math.sin(time / 300 + t.id)})`;
      ctx.beginPath();
      ctx.arc(x + 4 * Math.sin(time / 500 + t.id), y - 14 - ((time / 40 + t.id * 7) % 16), 7, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.rotate(d.a);
    // Paletler
    ctx.fillStyle = '#2b2622';
    roundRect(ctx, -15, -13, 30, 7, 2);
    ctx.fill();
    roundRect(ctx, -15, 6, 30, 7, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    const off = ((d.x + d.y) * 0.6) % 5;
    for (let i = -15 + off; i < 15; i += 5) {
      ctx.beginPath(); ctx.moveTo(i, -13); ctx.lineTo(i, -6); ctx.moveTo(i, 6); ctx.lineTo(i, 13); ctx.stroke();
    }
    // Gövde
    ctx.fillStyle = col;
    roundRect(ctx, -12, -9, 24, 18, 4);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Namlu ve kule
    ctx.fillStyle = '#3b3530';
    ctx.fillRect(2, -2.5, 19, 5);
    ctx.strokeRect(2, -2.5, 19, 5);
    ctx.fillStyle = shade(col, 0.78);
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Mayın kuruluyor: 3 saniyede dolan bar
    if (t.plant > 0) {
      const k = Math.min(1, t.plant / (TK.plantSeconds * TA.TPS)), bw = 40, bx = x - bw / 2, by = y + 24;
      ctx.fillStyle = INK;
      roundRect(ctx, bx - 2, by - 2, bw + 4, 10, 4);
      ctx.fill();
      ctx.fillStyle = '#5a4a3a';
      ctx.fillRect(bx, by, bw, 6);
      ctx.fillStyle = k >= 1 ? '#3ecf8e' : '#ffd23f';
      ctx.fillRect(bx, by, bw * k, 6);
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('💣', bx - 4, by + 3);
    }
    if (t.id === myId) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, TK.tankR + 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (pl) {
      ctx.font = 'bold 12px Nunito, Trebuchet MS, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.fillStyle = '#fff';
      const nm = (pl.admin ? '👑 ' : '') + pl.name;
      ctx.strokeText(nm, x, y - TK.tankR - 11);
      ctx.fillText(nm, x, y - TK.tankR - 11);
      ctx.save();
      ctx.translate(x - 6, y - TK.tankR - 25);
      drawSocial(pl, time);
      ctx.restore();
    }
  }

  function drawTankGame(time, tp, dt) {
    if (!inView(TK.x + TK.w / 2, TK.y + TK.h / 2, 1400)) return;
    const map = tsim ? tsim.map : demoMap;
    ctx.drawImage(arenaCanvas(map), TK.x - 20, TK.y - 20);
    drawTPads();
    if (tsim && tp) {
      // Kendi mayınlarım (sadece ben görürüm)
      for (const m of tsim.mines) {
        const x = TK.x + m.x, y = TK.y + m.y;
        ctx.globalAlpha = m.armed ? 0.9 : 0.5;
        ctx.fillStyle = '#4a4a4a';
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, TK.mineR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = Math.floor(time / 400) % 2 ? '#ff3b30' : '#7a1a14';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      for (const t of tsim.players.values()) if (!t.alive && t.x >= 0) drawTank(t, tp.get(t.id) || t, time);
      for (const t of tsim.players.values()) if (t.alive) drawTank(t, tp.get(t.id) || t, time);
      ctx.fillStyle = '#1b1b1b';
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1;
      for (const b of tsim.bullets) {
        const d = tp.get('b' + b.id) || b;
        ctx.beginPath();
        ctx.arc(TK.x + d.x, TK.y + d.y, TK.bulletR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    drawBooms(dt);
  }

  let lastTPhase = null;
  function drawTOverlay() {
    const g = lobby.tRunning && tmeta && (inTank() || nearArena()) ? tmeta : null;
    if (!g) { lastTPhase = null; return; }
    if (g.ph === 'ready') {
      ctx.save();
      ctx.font = '900 64px Nunito, Trebuchet MS, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 7;
      ctx.strokeStyle = INK;
      ctx.fillStyle = '#fff';
      ctx.strokeText(`Tur ${g.rd}`, vw / 2, vh * 0.42);
      ctx.fillText(`Tur ${g.rd}`, vw / 2, vh * 0.42);
      ctx.restore();
      if (lastTPhase !== 'ready') SFX.beep();
    }
    lastTPhase = g.ph;
  }

  let tHudKey = '';
  function updateTHud() {
    const g = lobby.tRunning && tsim && (inTank() || nearArena()) ? tsim : null;
    let key = 'off';
    if (g) {
      const me_ = g.players.get(myId);
      const ammo = me_ ? TK.maxBullets - g.bullets.filter((b) => b.owner === myId).length : 0;
      const list = [...g.players.keys()].map((id) => [id, g.score.get(id) || 0]).sort((a, b) => b[1] - a[1]);
      key = [g.round, ammo, me_ ? me_.minesLeft : -1, me_ ? me_.alive : 0, list.map((x) => x.join(':')).join(','),
        list.map(([id]) => (g.players.get(id).alive ? 1 : 0)).join('')].join('|');
      if (key !== tHudKey) {
        $('tRound').textContent = `Tur ${g.round}`;
        const box = $('tList');
        box.innerHTML = '';
        for (const [id, sc] of list) {
          const p = players.get(id), t = g.players.get(id);
          const el = document.createElement('span');
          el.className = 'tp' + (t.alive ? '' : ' dead') + (id === myId ? ' me' : '');
          const dot = document.createElement('i');
          dot.style.background = p ? p.color : '#888';
          el.append(dot, document.createTextNode(`${p ? p.name : '?'} ${sc}`));
          box.appendChild(el);
        }
        $('tAmmo').classList.toggle('hidden', !me_);
        if (me_) {
          $('tAmmo').textContent = '●'.repeat(ammo) + '○'.repeat(TK.maxBullets - ammo) + '   ' + '💣'.repeat(me_.minesLeft) + (me_.minesLeft ? '' : '—');
        }
      }
    }
    if (key === tHudKey) return;
    tHudKey = key;
    $('tscore').classList.toggle('hidden', !g);
  }

  // Bot kutuları: takım alanlarının altında küçük düğmeler
  function drawBotPads() {
    const hover = joined && !inMatch() && !inRace() && !inVb() && !inHk() && !inTank() ? me : null;
    const teams = { f: H.teams, v: W.VB.teams, h: W.HK.teams };
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 14px Nunito, Trebuchet MS, sans-serif';
    for (const bp of BOT_PADS) {
      const r = bp.r;
      if (!inView(r.x + r.w / 2, r.y, 200)) continue;
      const over = hover && W.inRect(hover.x, hover.y, r);
      const base = bp.team ? teams[bp.g][bp.team].color : bp.g === 't' ? '#7b5e3b' : '#2e7d32';
      ctx.fillStyle = INK;
      roundRect(ctx, r.x + 3, r.y + 4, r.w, r.h, 10);
      ctx.fill();
      ctx.fillStyle = over ? '#fff8ec' : base;
      roundRect(ctx, r.x, r.y, r.w, r.h, 10);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      if (bp.op === 'del') {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        roundRect(ctx, r.x, r.y, r.w, r.h, 10);
        ctx.fill();
      }
      ctx.fillStyle = over ? INK : '#fff';
      const label = bp.op === 'add' ? '+ 🤖 Bot' : bp.op === 'del' ? '− 🤖 Bot' : bp.g === 't' ? `🤖 ${W.TK.maxTanks} tanka doldur` : '🤖 Startı botlarla doldur';
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
    }
    ctx.restore();
  }

  // ---------- Ping göstergesi ----------
  let rttMs = null, lastPongAt = 0, lastSnapAt = 0, pingKey = '';
  setInterval(() => {
    if (connected) send({ t: 'png', c: performance.now() });
  }, 2000);
  function updatePing() {
    if (!joined) return;
    const now = performance.now();
    // Maçta/yarışta 0.4 sn'den uzun durum gelmezse ya da ping cevabı 5 sn gecikirse bağlantı zayıf
    const playing = (inMatch() && sim) || (inRace() && rsim) || (inVb() && vsim) || (inHk() && hsim) || (inTank() && tsim);
    const weak = !connected || (playing && now - lastSnapAt > 400) || (lastPongAt && now - lastPongAt > 5000);
    const ms = rttMs == null ? null : Math.round(rttMs);
    const cls = weak ? 'bad weak' : ms == null ? '' : ms < 80 ? 'good' : ms < 150 ? 'ok' : 'bad';
    const key = cls + '|' + ms + '|' + weak;
    if (key === pingKey) return;
    pingKey = key;
    const el = $('ping');
    el.className = cls;
    $('pingMs').textContent = weak ? '⚠ zayıf' : ms == null ? '—' : String(ms);
    el.title = weak ? 'Bağlantı zayıf: sunucudan bilgi gecikiyor' : 'Sunucuya gidiş-dönüş süresi';
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
      get hsim() { return hsim; }, get hpending() { return hpending; },
      get tsim() { return tsim; },
      get bjs() { return bjs; }, bjTurn: () => ({ mine: bjMyTurn(), v: bjs && bjMySeat() >= 0 ? BJ.value(bjs.s[bjMySeat()].c).t : 0 }),
      get watching() { return watching; }, cycleWatch: () => cycleWatch(), get cam() { return cam; }, get zoom() { return zoom; },
      get vsim() { return vsim; }, get vpending() { return vpending; }, aim, setMouse: (b) => { mouseBits = b; }, get bits() { return inputBits(); },
      startStats: () => { corrStats = { ball: { n: 0, sum: 0, max: 0 }, me: { n: 0, sum: 0, max: 0 }, other: { n: 0, sum: 0, max: 0 } }; },
      get stats() { return corrStats; },
      get delay() { return inputDelay(); },
    };
  }

  // ---------- Ses ----------
  // Kameraya göre ses: uzaklık -> şiddet, yatay konum -> sağ/sol. Görüş alanı dışındaysa null
  function spatial(x, y, range = 1) {
    const cx = cam.x + wvw / 2, cy = cam.y + wvh / 2;
    const d = Math.hypot(x - cx, y - cy) / (Math.max(wvw, wvh) * 0.6 * range);
    if (d >= 1) return null;
    return { vol: (1 - d) * (1 - d), pan: Math.max(-1, Math.min(1, (x - cx) / (wvw / 2))) * 0.7 };
  }
  function nearField() {
    const F = W.FIELD;
    return cam.x + wvw > F.x && cam.x < F.x + F.w && cam.y + wvh > F.y && cam.y < F.y + F.h;
  }
  function updateSoundBtn() {
    const b = $('soundBtn');
    b.textContent = SFX.muted ? '🔇' : '🔊';
    b.title = SFX.muted ? 'Ses kapalı (M ile aç)' : 'Ses açık (M ile kapat)';
    b.classList.toggle('off', SFX.muted);
  }
  function toggleSound() {
    SFX.init();
    SFX.setMuted(!SFX.muted);
    SFX.toggle(!SFX.muted);
    updateSoundBtn();
    toast(SFX.muted ? '🔇 Ses kapatıldı (M ile aç)' : '🔊 Ses açıldı');
  }
  $('soundBtn').onclick = (e) => { e.stopPropagation(); toggleSound(); };
  updateSoundBtn();

  // Top sesleri: sadece ileri tahmin adımlarında (düzeltme sırasındaki tekrar oynatmalar ses çıkarmaz)
  let lastBallSnd = 0, lastKickSnd = 0;
  const BALL_R = H.ball.radius, POST_HIT = H.ball.radius + H.postRadius + 2;
  function ballSoundStep(step) {
    const b = sim.ball, vx0 = b.vx, vy0 = b.vy;
    const ready = new Map();
    for (const p of sim.players.values()) ready.set(p.id, p.kickReady);
    step();
    const dv = Math.hypot(b.vx - vx0, b.vy - vy0);
    if (dv < 0.35) return;
    const t = performance.now();
    let kicked = false;
    for (const p of sim.players.values()) if (ready.get(p.id) && !p.kickReady) kicked = true;
    if (kicked ? t - lastKickSnd < 150 : t - lastBallSnd < 70) return;
    const w = W.toWorld(b.x, b.y);
    const sp = spatial(w.x, w.y);
    if (!sp) return;
    lastBallSnd = t;
    if (kicked) {
      lastKickSnd = t;
      SFX.kick(sp.vol * Math.min(1, 0.55 + dv / 10), sp.pan);
      return;
    }
    const k = sp.vol * Math.min(1, dv / 3.5);
    for (const sx of [-H.ballAreaX, H.ballAreaX]) for (const sy of [-H.goalY, H.goalY]) {
      if (Math.hypot(b.x - sx, b.y - sy) < POST_HIT) { SFX.post(k, sp.pan); return; }
    }
    if (Math.abs(b.x) > H.ballAreaX) { SFX.net(k, sp.pan); return; }
    for (const p of sim.players.values()) {
      if (Math.hypot(b.x - p.x, b.y - p.y) < p.radius + BALL_R + 3) { SFX.touch(k, sp.pan); return; }
    }
    SFX.bounce(k, sp.pan);
  }

  // Yarış: ani hız değişimi = duvara ya da başka araca çarpma
  const crashAt = new Map();
  function crashSoundStep(step) {
    const before = new Map();
    for (const c of rsim.cars.values()) before.set(c.id, [c.vx, c.vy]);
    step();
    const t = performance.now();
    for (const c of rsim.cars.values()) {
      const v = before.get(c.id);
      if (!v) continue;
      const dv = Math.hypot(c.vx - v[0], c.vy - v[1]);
      if (dv < 0.5 || t - (crashAt.get(c.id) || 0) < 250) continue;
      const sp = c.id === myId ? { vol: 1, pan: 0 } : spatial(c.x, c.y);
      if (!sp) continue;
      crashAt.set(c.id, t);
      SFX.crash(sp.vol * Math.min(1, (dv - 0.3) / 3), sp.pan);
    }
  }

  const engines = new Map(); // araç id -> V8 motor sesi
  let aPrev = null, aSpeed = 0, lastKind = null;
  function audioFrame(dt, rr) {
    if (!joined || !SFX.on || dt <= 0) {
      for (const e of engines.values()) e.stop();
      engines.clear();
      return;
    }
    // --- Arazi: su, çamur, buz ---
    const onFoot = !inMatch() && !inRace() && !inVb() && !inHk() && !inTank();
    const kind = onFoot ? W.terrainAt(me.x, me.y).kind : null;
    const moved = aPrev ? Math.hypot(me.x - aPrev.x, me.y - aPrev.y) : 0;
    aPrev = { x: me.x, y: me.y };
    const jump = moved > 300; // ışınlanma (tp, maça giriş) hareket sayılmaz
    aSpeed += ((jump ? 0 : moved / dt) - aSpeed) * Math.min(1, dt * 10);
    const water = kind && W.isWater(kind);
    if (!jump && lastKind && kind) {
      const wasWater = W.isWater(lastKind);
      if (water && !wasWater) SFX.splash(0.35 + aSpeed / 900, 0);
      else if (!water && wasWater) SFX.drip(0);
      if (kind === 'mud' && lastKind !== 'mud') SFX.squelch(0.4 + aSpeed / 500, 0);
      if (kind === 'ice' && lastKind !== 'ice') SFX.iceTick(0);
    }
    lastKind = kind;
    SFX.loop('water').set(water ? Math.min(1, aSpeed / 350) : 0);
    SFX.loop('mud').set(kind === 'mud' ? Math.min(1, aSpeed / 160) : 0);
    // Hokeyde kendi diskinin hızına göre paten sesi
    const skate = inHk() && hsim && hsim.players.get(myId);
    SFX.loop('ice').set(skate ? Math.min(1, Math.hypot(skate.vx, skate.vy) / 4) : kind === 'ice' ? Math.min(1, aSpeed / 700) : 0);
    // Uzaktan nehir/göl uğultusu: kameranın suya uzaklığına göre
    const cx = cam.x + wvw / 2, cy = cam.y + wvh / 2;
    let amb = 0;
    if (cx < W.CAMP_W + 400 && !inRace()) {
      const L = W.LAKE;
      const r = Math.hypot((cx - L.cx) / L.rx, (cy - L.cy) / L.ry);
      const dL = (r - 1) * Math.min(L.rx, L.ry);
      const dR = W.riverNearest(cx, cy).d - W.RIVER.width / 2;
      amb = Math.max(0, Math.min(1, 1 - Math.max(0, Math.min(dL, dR)) / 650));
    }
    SFX.loop('river').set(amb);
    // Maç sırasında tribün uğultusu
    const fsp = lobby.running ? spatial(H.cx, H.cy, 1.6) : null;
    const vsp = lobby.vRunning ? spatial(VB.cx, VB.cy, 1.6) : null;
    const hsp = lobby.hRunning ? spatial(HK.cx, HK.cy, 1.6) : null;
    SFX.loop('crowd').set(Math.max(fsp ? (inMatch() ? 1 : fsp.vol) : 0, vsp ? (inVb() ? 1 : vsp.vol) : 0, hsp ? (inHk() ? 1 : hsp.vol) : 0));

    // --- Yarış: V8 motorlar, lastik, kerb, çim ---
    const want = new Map();
    if (rr && (inRace() || nearTrack())) {
      const list = [];
      for (const [id, d] of rr) {
        const sp = id === myId ? { vol: 1, pan: 0 } : spatial(d.x, d.y, 1.3);
        if (sp && sp.vol > 0.03) list.push([id, d, sp]);
      }
      list.sort((a, b) => b[2].vol - a[2].vol);
      for (const x of list.slice(0, 5)) want.set(x[0], x);
    }
    for (const [id, e] of engines) if (!want.has(id)) { e.stop(); engines.delete(id); }
    for (const [id, [, d, sp]] of want) {
      let e = engines.get(id);
      if (!e) { e = SFX.engine(); if (!e) break; engines.set(id, e); }
      const c = d.car;
      const thr = c.finished ? 0 : id === myId ? inputBits() & 1 : c.input & 1;
      e.update(RC.kmh(c), thr, id === myId ? 1 : sp.vol * 0.55, sp.pan, dt);
    }
    const mine = inRace() && rr ? rr.get(myId) : null;
    let screech = 0, gravel = 0, kerb = 0;
    if (mine) {
      const c = mine.car, fx = Math.cos(mine.a), fy = Math.sin(mine.a);
      const lat = Math.abs(-c.vx * fy + c.vy * fx), spd = Math.hypot(c.vx, c.vy);
      const road = c.surface === 'road' || c.surface === 'kerb';
      screech = road ? Math.max(0, Math.min(1, (lat - 0.45) / 1.4)) : 0;
      gravel = road ? 0 : Math.min(1, spd / 4);
      kerb = c.surface === 'kerb' ? Math.min(1, spd / 3) : 0;
    }
    SFX.loop('screech').set(screech);
    SFX.loop('gravel').set(gravel);
    SFX.loop('kerb').set(kerb);
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
    const fence = lobby.running && W.inRect(me.x, me.y, W.FIELD) ? W.FIELD
      : lobby.vRunning && W.inRect(me.x, me.y, W.VFIELD) ? W.VFIELD
      : lobby.hRunning && W.inRect(me.x, me.y, W.HFIELD) ? W.HFIELD
      : lobby.tRunning && W.inRect(me.x, me.y, W.TFIELD) ? W.TFIELD : null;
    if (fence) {
      const F = fence, m = 2;
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
    c.strokeStyle = '#fff';
    c.lineWidth = 14;
    c.strokeRect(W.VB.cx - W.VB.courtX * W.VB.S, W.VB.cy - W.VB.courtY * W.VB.S, W.VB.courtX * 2 * W.VB.S, W.VB.courtY * 2 * W.VB.S);
    c.fillStyle = '#b39a76';
    c.fillRect(W.TFIELD.x, W.TFIELD.y, W.TFIELD.w, W.TFIELD.h);
    c.strokeStyle = '#6b5440';
    c.lineWidth = 12;
    c.strokeRect(W.TFIELD.x, W.TFIELD.y, W.TFIELD.w, W.TFIELD.h);
    c.fillStyle = '#d4eefa';
    roundRect(c, W.HFIELD.x, W.HFIELD.y, W.HFIELD.w, W.HFIELD.h, W.HK.cornerR * W.HK.S);
    c.fill();
    c.strokeStyle = '#fff';
    c.stroke();
    c.fillStyle = '#555';
    c.fillRect(W.VB.cx - 6, W.VB.cy - W.VB.netHalf * W.VB.S, 12, W.VB.netHalf * 2 * W.VB.S);
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
    ctx.fillText('Takım alanına tıkla, hazır ol · Başlat’a tıkla, maç başlasın', 1000, 1146);
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
      SK.draw(ctx, p.skin, time);
      ctx.restore();
      ctx.save();
      wavePath(time, true);
      ctx.clip();
      SK.draw(ctx, p.skin, time);
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
      SK.draw(ctx, p.skin, time);
      ctx.fillStyle = 'rgba(106,76,48,0.55)';
      ctx.beginPath();
      ctx.moveTo(-2, 16);
      ctx.quadraticCurveTo(8, 12, 18, 16);
      ctx.lineTo(18, 30);
      ctx.lineTo(-2, 30);
      ctx.fill();
    } else {
      SK.draw(ctx, p.skin, time);
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
    ctx.strokeRect(x0 + cam.x * MM_S, y0 + cam.y * MM_S, wvw * MM_S, wvh * MM_S);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x0 + ball.x * MM_S, y0 + ball.y * MM_S, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (hsim && puckPos) {
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.arc(x0 + puckPos.x * MM_S, y0 + puckPos.y * MM_S, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (vsim) {
      const vb = W.vbToWorld(vsim.ball.x, vsim.ball.y);
      ctx.fillStyle = '#ffe066';
      ctx.beginPath();
      ctx.arc(x0 + vb.x * MM_S, y0 + vb.y * MM_S, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
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
        drawDisc(players.get(id), W.toWorld(d.x, d.y), q, id === myId, time, H.player.radius * H.S, H.teams);
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

  function drawDisc(pl, d, q, isMe, time, r = H.player.radius * H.S, teams = H.teams) {
    const S = H.S;
    ctx.fillStyle = teams[q.team].color;
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
  let lastPhase = null, lastCount = 0;
  function drawOverlay() {
    const ph = lobby.running && meta ? meta.ph : null;
    if (ph !== lastPhase) {
      if (lastPhase === 'countdown' && ph === 'kickoff') {
        announce('BAŞLA!', '#fff', `${meta.half}. Devre`);
        if (inMatch() || nearField()) SFX.whistle('start');
      }
      lastPhase = ph;
    }
    if (ph === 'countdown') {
      const n = Math.max(1, Math.ceil(meta.tmr / HB.TPS));
      if (n !== lastCount && (inMatch() || nearField())) SFX.beep();
      lastCount = n;
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
    const sx = (me.x - Math.round(cam.x)) * zoom, sy = (me.y - Math.round(cam.y)) * zoom; // menü imleci/diski takip eder
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

  // ---------- Blackjack ----------
  // Sunucu durumu 'bj' mesajıyla gelir (tur tabanlı, tahmin yok). Kartlar destelikten yerine kayarak gelir.
  const BJ = W.BJ, BJP = W.BJPADS;
  let bjs = null, bjRound = 0, bjWasMyTurn = false;
  const bjSeen = new Map(); // kart anahtarı -> ilk görüldüğü an (kayma animasyonu)
  function bjMySeat() {
    return bjs ? bjs.s.findIndex((q) => q && q.id === myId) : -1;
  }
  function inBj() {
    return bjMySeat() >= 0;
  }
  function bjMyTurn() {
    return !!bjs && bjs.ph === 'turns' && bjs.turn >= 0 && bjs.turn === bjMySeat();
  }
  function bjLeft() {
    return bjs ? Math.max(0, bjs.left - (performance.now() - bjs.at)) : 0;
  }
  function nearBj() {
    const F = W.BJFIELD;
    return cam.x + wvw > F.x && cam.x < F.x + F.w && cam.y + wvh > F.y && cam.y < F.y + F.h;
  }
  function onBj(m) {
    const prev = bjs;
    if (m.ph === 'deal' && (!prev || prev.ph !== 'deal')) {
      bjRound++;
      bjSeen.clear();
    }
    m.at = performance.now();
    const count = (q) => (q ? q.d.length + q.s.reduce((a, x) => a + (x ? x.c.length : 0), 0) : 0);
    bjs = m;
    document.body.classList.toggle('in-bj', inBj());
    if (count(m) > count(prev) && (inBj() || nearBj())) SFX.card();
    const mine = bjMyTurn();
    if (mine && !bjWasMyTurn) {
      SFX.beep();
      toast('🃏 Sıra sende! Space / W: kart çek · S: dur');
    }
    bjWasMyTurn = mine;
  }
  function onBjResult(m) {
    scores = m.scores || scores;
    renderPlayerList();
    const r = m.results.find((x) => x.id === myId);
    if (!r) return;
    const T = {
      bj: ['🃏 BLACKJACK!', '#ffd23f', '+1 puan'], win: ['Kazandın!', '#3ecf8e', '+1 puan'],
      push: ['Berabere', '#fff', 'Puan yok'], lose: ['Kaybettin', '#ff8a7a', 'Krupiye kazandı'],
    }[r.res];
    announce(T[0], T[1], T[2]);
    if (r.res === 'win' || r.res === 'bj') SFX.goal();
  }
  function bjSend(a) {
    if (!bjMyTurn()) return;
    SFX.click();
    send({ t: 'bj', a });
  }

  const CARD_W = 46, CARD_H = 64;
  function drawCard(x, y, c) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    roundRect(ctx, -CARD_W / 2 + 2, -CARD_H / 2 + 3, CARD_W, CARD_H, 6);
    ctx.fill();
    ctx.fillStyle = c < 0 ? '#b8323a' : '#fffdf6';
    roundRect(ctx, -CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 6);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (c < 0) {
      // Kapalı kart: çapraz desen
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      roundRect(ctx, -CARD_W / 2 + 4, -CARD_H / 2 + 4, CARD_W - 8, CARD_H - 8, 4);
      ctx.stroke();
      ctx.save();
      ctx.clip();
      for (let k = -CARD_H; k < CARD_H; k += 7) {
        ctx.beginPath();
        ctx.moveTo(-CARD_W / 2, k);
        ctx.lineTo(CARD_W / 2, k + CARD_W);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      const col = BJ.red(c) ? '#d02a2a' : '#1d1d1d';
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 15px Arial, sans-serif';
      ctx.fillText(BJ.rank(c), -CARD_W / 2 + 4, -CARD_H / 2 + 4);
      ctx.font = '13px Arial, sans-serif';
      ctx.fillText(BJ.suit(c), -CARD_W / 2 + 4, -CARD_H / 2 + 20);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '26px Arial, sans-serif';
      ctx.fillText(BJ.suit(c), 3, 8);
    }
    ctx.restore();
  }
  // Bir el: kartlar yan yana biraz üst üste; yeni kart destelikten kayarak gelir
  function drawHand(key, cards, cx, cy, time) {
    const gap = 24, x0 = cx - ((cards.length - 1) * gap) / 2;
    const shoe = { x: BJ.cx + BJ.rx - 110, y: BJ.top + 55 };
    cards.forEach((c, k) => {
      const id = `${bjRound}:${key}:${k}`;
      if (!bjSeen.has(id)) bjSeen.set(id, time);
      const a = Math.min(1, (time - bjSeen.get(id)) / 280), e = 1 - (1 - a) * (1 - a);
      const tx = x0 + k * gap, ty = cy - k * 2;
      drawCard(shoe.x + (tx - shoe.x) * e, shoe.y + (ty - shoe.y) * e, c);
    });
  }
  function bjBadge(x, y, text, bg, fg = '#fff') {
    ctx.font = 'bold 14px Nunito, Trebuchet MS, sans-serif';
    const w = ctx.measureText(text).width + 16;
    ctx.fillStyle = bg;
    roundRect(ctx, x - w / 2, y - 11, w, 22, 11);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 1);
  }
  function handLabel(cards) {
    const v = BJ.value(cards);
    if (BJ.isBlackjack(cards)) return 'Blackjack';
    return v.soft && v.t < 21 ? `${v.t - 10}/${v.t}` : String(v.t);
  }

  function drawBlackjack(time) {
    const F = W.BJFIELD;
    if (!inView(F.x + F.w / 2, F.y + F.h / 2, Math.max(F.w, F.h) / 2 + 100)) return;
    const { cx, top, rx, ry } = BJ;
    const shape = (k, dy) => {
      ctx.beginPath();
      ctx.moveTo(cx - rx * k, top + dy);
      ctx.lineTo(cx + rx * k, top + dy);
      ctx.ellipse(cx, top + dy, rx * k, ry * k, 0, 0, Math.PI);
      ctx.closePath();
    };
    // Tabela
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px Nunito, Trebuchet MS, sans-serif';
    ctx.fillStyle = INK;
    ctx.fillText('🃏 Blackjack Masası', cx, top - 62);
    // Masa: gölge, ahşap kenar, çuha
    ctx.save();
    ctx.translate(6, 8);
    shape(1.06, -22);
    ctx.fillStyle = 'rgba(59,47,36,0.35)';
    ctx.fill();
    ctx.restore();
    shape(1.06, -22);
    ctx.fillStyle = '#6b3f22';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.stroke();
    shape(1, 0);
    const g = ctx.createRadialGradient(cx, top + 120, 40, cx, top + 120, rx);
    g.addColorStop(0, '#2a9160');
    g.addColorStop(1, '#17663f');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, top, rx * 0.5, ry * 0.5, 0, 0.12, Math.PI - 0.12);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.font = 'bold 15px Nunito, Trebuchet MS, sans-serif';
    ctx.fillText('KRUPİYE 16\'DA ÇEKER · 17\'DE DURUR', cx, top + 162);
    // Destelik
    const shoe = { x: cx + rx - 110, y: top + 55 };
    for (let k = 3; k >= 0; k--) drawCard(shoe.x + k * 2, shoe.y - k * 2, -1);
    if (bjs) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = 'bold 13px Nunito, Trebuchet MS, sans-serif';
      ctx.fillText(`${bjs.n} kart`, shoe.x, shoe.y + 46);
    }
    // Krupiye
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = 'bold 15px Nunito, Trebuchet MS, sans-serif';
    ctx.fillText('KRUPİYE', cx, top + 20);
    if (bjs && bjs.d.length) {
      drawHand('d', bjs.d, cx, top + 78, time);
      const hidden = bjs.d.includes(-1);
      bjBadge(cx, top + 128, hidden ? `${BJ.value(bjs.d).t} + ?` : handLabel(bjs.d), BJ.value(bjs.d).t > 21 ? '#c0392b' : '#1a2130');
    }
    // Koltuklar: eller, durumlar, sıra
    const left = bjLeft();
    for (let i = 0; i < BJ.seats; i++) {
      const q = bjs && bjs.s[i];
      const p = BJ.seatPos(i, 0.66);
      if (!q) continue;
      const turn = bjs.ph === 'turns' && bjs.turn === i;
      if (turn) {
        // Sırası gelen: parlayan halka + kalan süre yayı
        ctx.strokeStyle = '#ffd23f';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + 4, 80, 58, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + 4, 88, 66, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (left / (BJ.turnSeconds * 1000)));
        ctx.stroke();
      }
      if (q.c.length) {
        drawHand('s' + i, q.c, p.x, p.y, time);
        const v = BJ.value(q.c).t;
        let label = handLabel(q.c), bg = '#1a2130', fg = '#fff';
        if (q.st === 'bust') { label = `${v} · BATTI`; bg = '#c0392b'; }
        else if (q.st === 'bj') { bg = '#ffd23f'; fg = INK; }
        bjBadge(p.x, p.y + 48, label, bg, fg);
        if (q.r) {
          const R = { win: ['KAZANDI +1', '#2e9e5b'], bj: ['BLACKJACK +1', '#e0a400'], push: ['BERABERE', '#5689e5'], lose: ['KAYBETTİ', '#6b6b6b'] }[q.r];
          bjBadge(p.x, p.y - 50, R[0], R[1]);
        }
      } else if (q.w && bjs.ph !== 'idle') {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = 'bold 14px Nunito, Trebuchet MS, sans-serif';
        ctx.fillText('Sonraki eli bekliyor', p.x, p.y);
      }
    }
    // Koltuk alanları
    const hover = joined && !inMatch() && !inRace() && !inVb() && !inHk() && !inTank() && !watching ? me : null;
    const over = (pad) => hover && W.inRect(hover.x, hover.y, pad);
    const my = bjMySeat();
    for (let i = 0; i < BJ.seats; i++) {
      const pad = BJP['s' + i], q = bjs && bjs.s[i];
      const pl = q && players.get(q.id);
      const turn = q && bjs.ph === 'turns' && bjs.turn === i;
      if (!q) padBox(pad, '#a8916b', `🪑 Koltuk ${i + 1}`, ['(boş — tıkla, otur)'], over(pad));
      else if (i === my) padBox(pad, turn ? '#f0a93b' : '#2e8b57', `✓ ${pl ? pl.name : 'Sen'}`, [turn ? `Sıra sende · ${Math.ceil(left / 1000)} sn` : 'Kalkmak için tıkla'], over(pad));
      else padBox(pad, turn ? '#f0a93b' : '#7b5e3b', pl ? pl.name : '…', [turn ? `Oynuyor · ${Math.ceil(left / 1000)} sn` : q.w ? 'Bekliyor' : 'Masada'], over(pad));
    }
    // Hamle alanları
    const myTurn = bjMyTurn();
    padBox(BJP.hit, myTurn ? '#2e9e5b' : '#8a8a8a', '➕ Kart Çek', [myTurn ? 'Space / W' : 'Sıran gelince'], over(BJP.hit));
    padBox(BJP.stand, myTurn ? '#c0392b' : '#8a8a8a', '✋ Dur', [myTurn ? 'S' : 'Sıran gelince'], over(BJP.stand));
    const seated = bjs ? bjs.s.filter(Boolean).length : 0;
    let title = '🃏 Dağıt', lines, fill = '#f0a93b';
    if (!bjs || bjs.ph === 'idle') lines = seated ? [`${seated}/${BJ.seats} oyuncu · eli başlat`] : ['Önce koltuğa otur'];
    else if (bjs.ph === 'result') { title = '🃏 Yeni el'; fill = '#8a8a8a'; lines = [`${Math.ceil(left / 1000)} sn sonra`]; }
    else { title = '🃏 El sürüyor'; fill = '#8a8a8a'; lines = [bjs.ph === 'dealer' ? 'Krupiye oynuyor' : bjs.ph === 'deal' ? 'Kartlar dağıtılıyor' : 'Oyuncular oynuyor']; }
    padBox(BJP.deal, fill, title, lines, over(BJP.deal));
    ctx.fillStyle = 'rgba(59,47,36,0.75)';
    ctx.font = '600 14px Nunito, Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('🃏 Koltuğa tıkla otur · Dağıt · sıran gelince Space/W kart çek, S dur · krupiyeyi geçen +1 puan · L masadan kalk', cx, BJP.deal.y + BJP.deal.h + 16);
  }

  // ---------- İzleyici modu ----------
  // Oyunda olmayan oyuncu süren bir maçı izleyebilir: kamera sahayı ortalar, ekrana sığmıyorsa
  // uzaklaşır (imleç olduğu yerde kalır). Yarışta öndeki aracı takip eder.
  const WATCH = [
    ['f', '⚽ Futbol', () => lobby.running],
    ['v', '🏐 Voleybol', () => lobby.vRunning],
    ['h', '🏒 Hokey', () => lobby.hRunning],
    ['t', '💣 Tank', () => lobby.tRunning],
    ['r', '🏎️ Yarış', () => lobby.raceRunning],
    ['b', '🃏 Blackjack', () => !!bjs && bjs.ph !== 'idle' && !inBj()],
  ];
  const WATCH_RECT = { f: W.FIELD, v: W.VFIELD, h: W.HFIELD, t: W.TFIELD, b: W.BJFIELD };
  let watching = null, watchKey = '';
  function watchable() {
    if (!joined || inMatch() || inRace() || inVb() || inHk() || inTank()) return [];
    return WATCH.filter((w) => w[2]());
  }
  function setWatch(g) {
    if (g === watching) return;
    watching = g;
    send({ t: 'watch', g });
    inAx = inAy = 0;
    radial = null;
    document.body.classList.toggle('watching', !!g);
    updateWatchUi();
  }
  function cycleWatch() {
    const list = watchable();
    const i = list.findIndex((w) => w[0] === watching);
    setWatch(i + 1 < list.length ? list[i + 1][0] : null);
  }
  function updateWatchUi() {
    const list = watchable();
    if (watching && !list.some((w) => w[0] === watching)) return setWatch(null); // maç bitti ya da oyuna girdim
    const key = list.map((w) => w[0]).join('') + '|' + watching;
    if (key === watchKey) return;
    watchKey = key;
    const bar = $('watchBar');
    bar.classList.toggle('hidden', !list.length);
    bar.innerHTML = '<span>👁 İzle</span>';
    for (const [g, label] of list) {
      const b = document.createElement('button');
      b.className = 'btn2 small' + (g === watching ? ' on' : '');
      b.textContent = label;
      b.title = g === watching ? 'İzlemeyi bırak' : 'Bu maçı izle';
      b.onclick = () => setWatch(watching === g ? null : g);
      bar.appendChild(b);
    }
    const k = document.createElement('kbd');
    k.textContent = 'V';
    k.title = 'Oyun modunda V: sıradaki maç / kapat';
    bar.appendChild(k);
  }
  function watchTarget(rr) {
    const R = WATCH_RECT[watching];
    if (R) return { x: R.x + R.w / 2, y: R.y + R.h / 2 };
    const st = raceStandings();
    const lead = st.find((c) => !c.finished) || st[0];
    const c = lead && rr && rr.get(lead.id);
    return c ? { x: c.x, y: c.y } : { x: TR.PADS.join.x, y: TR.PADS.join.y };
  }
  function watchZoom() {
    const R = WATCH_RECT[watching];
    if (!R) return 1;
    return Math.min(1, (vw - 40) / (R.w + 160), (vh - 120) / (R.h + 200));
  }

  // ---------- Döngü ----------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = innerWidth;
    vh = innerHeight;
    wvw = vw / zoom;
    wvh = vh / zoom;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = vw + 'px';
    canvas.style.height = vh + 'px';
  }
  addEventListener('resize', resize);
  resize();

  const camLead = { x: 0, y: 0 };
  function updateCamera(dt) {
    const tx = me.x + camLead.x - wvw / 2, ty = me.y + camLead.y - wvh / 2;
    const k = cam.init ? 1 - Math.exp(-dt * 5) : 1;
    cam.init = true;
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    const clampAxis = (v, view, size) => (view >= size ? (size - view) / 2 : Math.max(0, Math.min(size - view, v)));
    cam.x = clampAxis(cam.x, wvw, W.W);
    cam.y = clampAxis(cam.y, wvh, W.H);
  }

  let lastRp = null;
  let last = performance.now();
  function frame(time) {
    const dt = Math.min(0.1, (time - last) / 1000);
    last = time;
    advanceSim(dt);
    advanceRace(dt);
    advanceV(dt);
    advanceH(dt);
    advanceT(dt);
    vHitSound();
    const rp = sim ? renderPositions(Math.min(1, simAcc / TICK)) : null;
    lastRp = rp;
    const rr = rsim ? raceRender(Math.min(1, racc / TICK)) : null;
    lastRr = rr;
    const myDisc = inMatch() && rp ? rp.get(myId) : null;
    const myCar = inRace() && rr ? rr.get(myId) : null;
    const vp = vsim ? vRender(Math.min(1, vacc / TICK)) : null;
    const myV = inVb() && vp ? vp.get(myId) : null;
    const hp = hsim ? hRender(Math.min(1, hacc / TICK)) : null;
    const myH = inHk() && hp ? hp.get(myId) : null;
    const tp = tsim ? tRender(Math.min(1, tacc / TICK)) : null;
    const myT = inTank() && tp ? tp.get(myId) : null;
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
    } else if (myV) {
      // Voleybolda kamera oyuncuyla nişan arasına bakar
      const w = W.vbToWorld(myV.x, myV.y);
      me.x = w.x;
      me.y = w.y;
      me.vx = me.vy = 0;
      inAx = inAy = 0;
      camLead.x = (aim.x - myV.x) * VB.S * 0.35;
      camLead.y = (aim.y - myV.y) * VB.S * 0.35;
    } else if (myH) {
      // Hokeyde kamera kayış yönüne biraz önden bakar
      const w = W.hkToWorld(myH.x, myH.y);
      me.x = w.x;
      me.y = w.y;
      me.vx = me.vy = 0;
      inAx = inAy = 0;
      const q = hsim.players.get(myId);
      if (q) {
        camLead.x = q.vx * HK.S * 25;
        camLead.y = q.vy * HK.S * 25;
      }
    } else if (inTank()) {
      // Tankta bütün labirent görünsün: kamera arenanın ortasına bakar
      if (myT && myT.x >= 0) {
        me.x = TK.x + myT.x;
        me.y = TK.y + myT.y;
      }
      me.vx = me.vy = 0;
      inAx = inAy = 0;
      // Ekran labirenti alıyorsa ortasına bak, almıyorsa kendi tankını takip et (yakınlaştırma yok)
      if (wvw >= TK.w + 40) camLead.x = TK.x + TK.w / 2 - me.x;
      if (wvh >= TK.h + 120) camLead.y = TK.y + TK.h / 2 - me.y;
    } else if (watching) {
      // İzlerken imleç yerinde durur, kamera sahaya bakar
      me.vx = me.vy = 0;
      inAx = inAy = 0;
      const t = watchTarget(rr);
      camLead.x = t.x - me.x;
      camLead.y = t.y - me.y;
    } else if (joined && !inMatch() && !inRace() && !inVb() && !inHk()) stepMovement(dt);
    // Yakınlaştırma yumuşak geçer; görünen alan değişirken kamera merkezi sabit kalsın
    const targetZoom = myCar ? RACE_ZOOM : watching ? watchZoom() : 1;
    if (Math.abs(targetZoom - zoom) > 0.001) {
      const cx = cam.x + wvw / 2, cy = cam.y + wvh / 2;
      zoom += (targetZoom - zoom) * (1 - Math.exp(-dt * 4));
      wvw = vw / zoom;
      wvh = vh / zoom;
      cam.x = cx - wvw / 2;
      cam.y = cy - wvh / 2;
    } else {
      wvw = vw / zoom;
      wvh = vh / zoom;
    }
    updateCamera(dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ecd9a4';
    ctx.fillRect(0, 0, vw, vh);
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));
    const sx = Math.max(0, Math.floor(cam.x)), sy = Math.max(0, Math.floor(cam.y));
    const sw = Math.min(W.CAMP_W - sx, Math.ceil(wvw) + 2), sh = Math.min(W.CAMP_H - sy, Math.ceil(wvh) + 2);
    if (sw > 0 && sh > 0) ctx.drawImage(bg, sx, sy, sw, sh, sx, sy, sw, sh);
    if (nearTrack()) TRACKDRAW.draw(ctx, cam.x, cam.y, wvw, wvh);
    else if (joined) TRACKDRAW.prefetch(TR.PADS.join.x - wvw / 2, TR.PADS.join.y - wvh / 2);
    drawWater(time);
    drawPads(time);
    drawMatch(time, rp);
    drawRace(time, rr);
    drawVolley(time, vp);
    drawHockey(time, hp);
    drawTankGame(time, tp, dt);
    drawBlackjack(time);
    drawBotPads();

    const rt = time - INTERP_DELAY;
    for (const p of players.values()) {
      if (p.id === myId) continue;
      p.render = interp(p.snaps, rt);
      if (p.render && !(sim && sim.players.has(p.id)) && !(rr && rr.has(p.id)) && !(vsim && vsim.players.has(p.id)) && !(hsim && hsim.players.has(p.id)) && !(tsim && tsim.players.has(p.id) && tsim.players.get(p.id).x >= 0) && inView(p.render.x, p.render.y, 200)) {
        drawCursor(p, p.render.x, p.render.y, time, false);
      }
    }
    if (joined && !myDisc && !myCar && !myV && !myH && !inTank()) {
      const self = players.get(myId) || { name: me.name, color: me.color, skin: me.skin };
      drawCursor(self, me.x, me.y, time, true);
    }
    ctx.restore();
    audioFrame(dt, rr);
    if (joined && !inTank()) drawMinimap(); // tankta köşedeki tankları örtmesin
    drawOverlay();
    drawVOverlay();
    drawHOverlay();
    drawTOverlay();
    drawStartLights();
    updateHud();
    updateVHud();
    updateHHud();
    updateTHud();
    updateRaceHud();
    updatePing();
    updateWatchUi();
    requestAnimationFrame(frame);
  }

  function inView(x, y, m) {
    return x > cam.x - m && x < cam.x + wvw + m && y > cam.y - m && y < cam.y + wvh + m;
  }

  requestAnimationFrame(frame);
})();
