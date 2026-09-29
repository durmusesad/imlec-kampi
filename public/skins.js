// İmleç skinleri: katalog (sunucu + tarayıcı) ve çizim (sadece tarayıcı).
// Hepsi bu site için sıfırdan çizildi; Custom Cursor'daki popüler tarzlardan esinlenildi, görsel kopyalanmadı.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SKINS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // kind: 'solid' | 'grad' | 'pattern' | 'emoji'. color: isim etiketi, sohbet, oyuncu listesi ve yarış aracı rengi
  const PAGES = [
    { name: 'Klasik', skins: [
      { id: 'k-kirmizi', name: 'Kırmızı', kind: 'solid', color: '#ff5a5f' },
      { id: 'k-turuncu', name: 'Turuncu', kind: 'solid', color: '#ff9f1c' },
      { id: 'k-sari', name: 'Sarı', kind: 'solid', color: '#ffd23f' },
      { id: 'k-yesil', name: 'Yeşil', kind: 'solid', color: '#3ecf8e' },
      { id: 'k-mavi', name: 'Açık mavi', kind: 'solid', color: '#2ec4f1' },
      { id: 'k-lacivert', name: 'Mavi', kind: 'solid', color: '#4361ee' },
      { id: 'k-mor', name: 'Mor', kind: 'solid', color: '#9b5de5' },
      { id: 'k-pembe', name: 'Pembe', kind: 'solid', color: '#f15bb5' },
      { id: 'k-beyaz', name: 'Beyaz', kind: 'solid', color: '#f7f7f7', label: '#8a8a8a' },
      { id: 'k-siyah', name: 'Siyah', kind: 'solid', color: '#2a2a2e', outline: '#ffffff' },
      { id: 'k-altin', name: 'Altın', kind: 'grad', color: '#e0a800', stops: ['#fff3b0', '#f5c542', '#b8860b'] },
      { id: 'k-gumus', name: 'Gümüş', kind: 'grad', color: '#9aa4ae', stops: ['#ffffff', '#c3cad1', '#7d8790'] },
    ] },
    { name: 'Neon', skins: [
      { id: 'n-pembe', name: 'Neon pembe', kind: 'solid', color: '#ff2fb4', glow: '#ff2fb4' },
      { id: 'n-yesil', name: 'Neon yeşil', kind: 'solid', color: '#39ff6a', glow: '#39ff6a' },
      { id: 'n-mavi', name: 'Neon mavi', kind: 'solid', color: '#2ee6ff', glow: '#2ee6ff' },
      { id: 'n-mor', name: 'Neon mor', kind: 'solid', color: '#b14dff', glow: '#b14dff' },
      { id: 'g-gokkusagi', name: 'Gökkuşağı', kind: 'grad', color: '#ff5a5f', stops: ['#ff3b3b', '#ff9f1c', '#ffe23f', '#3ecf8e', '#2ec4f1', '#9b5de5'] },
      { id: 'g-gunbatimi', name: 'Gün batımı', kind: 'grad', color: '#ff7a59', stops: ['#ffd23f', '#ff7a59', '#c2185b'] },
      { id: 'g-okyanus', name: 'Okyanus', kind: 'grad', color: '#1e88e5', stops: ['#b2ebf2', '#26c6da', '#1565c0'] },
      { id: 'g-ates', name: 'Ateş', kind: 'grad', color: '#ff5722', stops: ['#fff176', '#ff9800', '#e53935'], glow: '#ff7043' },
      { id: 'g-buz', name: 'Buz', kind: 'grad', color: '#81d4fa', stops: ['#ffffff', '#b3e5fc', '#4fc3f7'], glow: '#b3e5fc' },
      { id: 'g-galaksi', name: 'Galaksi', kind: 'pattern', color: '#7e57c2', pattern: 'galaxy' },
      { id: 'g-seker', name: 'Pamuk şeker', kind: 'grad', color: '#f48fb1', stops: ['#f8bbd0', '#e1bee7', '#b3e5fc'] },
      { id: 'g-aurora', name: 'Kuzey ışıkları', kind: 'grad', color: '#26a69a', stops: ['#69f0ae', '#26a69a', '#5e35b1'], glow: '#69f0ae' },
    ] },
    { name: 'Desenler', skins: [
      { id: 'd-cizgili', name: 'Çizgili', kind: 'pattern', color: '#e53935', pattern: 'stripes', a: '#e53935', b: '#ffffff' },
      { id: 'd-puantiye', name: 'Puantiye', kind: 'pattern', color: '#ec407a', pattern: 'dots', a: '#ec407a', b: '#ffffff' },
      { id: 'd-dama', name: 'Dama', kind: 'pattern', color: '#424242', pattern: 'checker', a: '#111111', b: '#ffffff' },
      { id: 'd-kamuflaj', name: 'Kamuflaj', kind: 'pattern', color: '#6b8e23', pattern: 'camo' },
      { id: 'd-zebra', name: 'Zebra', kind: 'pattern', color: '#555555', pattern: 'zebra' },
      { id: 'd-leopar', name: 'Leopar', kind: 'pattern', color: '#d4a017', pattern: 'leopard' },
      { id: 'd-piksel', name: 'Piksel', kind: 'pattern', color: '#43a047', pattern: 'pixel' },
      { id: 'd-kot', name: 'Kot', kind: 'pattern', color: '#3f6fb5', pattern: 'denim' },
      { id: 'd-mermer', name: 'Mermer', kind: 'pattern', color: '#9e9e9e', pattern: 'marble' },
      { id: 'd-ekose', name: 'Ekose', kind: 'pattern', color: '#c62828', pattern: 'plaid' },
      { id: 'd-petek', name: 'Bal peteği', kind: 'pattern', color: '#ffb300', pattern: 'honey' },
      { id: 'd-karpuz', name: 'Karpuz', kind: 'pattern', color: '#ef5350', pattern: 'melon' },
    ] },
    { name: 'Sevimli', skins: [
      { id: 'e-kedi', name: 'Kedi', kind: 'emoji', color: '#ffb74d', emoji: '🐱' },
      { id: 'e-kopek', name: 'Köpek', kind: 'emoji', color: '#a1887f', emoji: '🐶' },
      { id: 'e-tilki', name: 'Tilki', kind: 'emoji', color: '#ff7043', emoji: '🦊' },
      { id: 'e-panda', name: 'Panda', kind: 'emoji', color: '#616161', emoji: '🐼' },
      { id: 'e-kurbaga', name: 'Kurbağa', kind: 'emoji', color: '#66bb6a', emoji: '🐸' },
      { id: 'e-tavsan', name: 'Tavşan', kind: 'emoji', color: '#f48fb1', emoji: '🐰' },
      { id: 'e-unicorn', name: 'Unicorn', kind: 'emoji', color: '#ce93d8', emoji: '🦄' },
      { id: 'e-penguen', name: 'Penguen', kind: 'emoji', color: '#455a64', emoji: '🐧' },
      { id: 'e-pizza', name: 'Pizza', kind: 'emoji', color: '#ffa726', emoji: '🍕' },
      { id: 'e-donut', name: 'Donut', kind: 'emoji', color: '#f06292', emoji: '🍩' },
      { id: 'e-dondurma', name: 'Dondurma', kind: 'emoji', color: '#f8bbd0', emoji: '🍦', label: '#ec407a' },
      { id: 'e-cilek', name: 'Çilek', kind: 'emoji', color: '#e53935', emoji: '🍓' },
    ] },
    { name: 'Temalar', skins: [
      { id: 't-hayalet', name: 'Hayalet', kind: 'emoji', color: '#90a4ae', emoji: '👻' },
      { id: 't-balkabagi', name: 'Bal kabağı', kind: 'emoji', color: '#fb8c00', emoji: '🎃' },
      { id: 't-cam', name: 'Yılbaşı', kind: 'emoji', color: '#2e7d32', emoji: '🎄' },
      { id: 't-kardan', name: 'Kardan adam', kind: 'emoji', color: '#4fc3f7', emoji: '⛄' },
      { id: 't-kilic', name: 'Kılıç', kind: 'emoji', color: '#78909c', emoji: '🗡️', rot: -0.8 },
      { id: 't-degnek', name: 'Sihirli değnek', kind: 'emoji', color: '#7e57c2', emoji: '🪄', rot: -1.35 },
      { id: 't-kalem', name: 'Kalem', kind: 'emoji', color: '#fbc02d', emoji: '✏️', rot: -2.35 },
      { id: 't-roket', name: 'Roket', kind: 'emoji', color: '#e53935', emoji: '🚀', rot: -1.57 },
      { id: 't-oyun', name: 'Oyun kolu', kind: 'emoji', color: '#5c6bc0', emoji: '🎮' },
      { id: 't-ates', name: 'Alev', kind: 'emoji', color: '#ff5722', emoji: '🔥' },
      { id: 't-elmas', name: 'Elmas', kind: 'emoji', color: '#29b6f6', emoji: '💎' },
      { id: 't-yildiz', name: 'Yıldız', kind: 'emoji', color: '#fdd835', emoji: '⭐', label: '#f9a825' },
    ] },
  ];
  const LIST = PAGES.flatMap((p) => p.skins);
  const BY_ID = Object.fromEntries(LIST.map((s) => [s.id, s]));
  const DEFAULT = 'k-kirmizi';
  const get = (id) => BY_ID[id] || BY_ID[DEFAULT];

  // ---------- Çizim (sadece tarayıcı) ----------
  const ARROW = [[0, 0], [0, 23], [5.5, 18], [9.5, 27], [13.5, 25.5], [9.5, 16.5], [16.5, 16.5]];
  const INK = '#3b2f24';
  const patternCache = new Map();

  function arrowPath(c) {
    c.beginPath();
    ARROW.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
  }

  // Desenler küçük bir karoya bir kez çizilip tekrar eden dolgu olarak kullanılır
  function makePattern(c, s) {
    if (patternCache.has(s.id)) return patternCache.get(s.id);
    const t = document.createElement('canvas');
    const N = 16;
    t.width = t.height = N;
    const g = t.getContext('2d');
    const rnd = (() => { let k = 7; return () => ((k = (k * 16807) % 2147483647) / 2147483647); })();
    switch (s.pattern) {
      case 'stripes':
        g.fillStyle = s.b; g.fillRect(0, 0, N, N);
        g.fillStyle = s.a;
        for (let i = -N; i < N * 2; i += 8) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 4, 0); g.lineTo(i + 4 - N, N); g.lineTo(i - N, N); g.fill(); }
        break;
      case 'dots':
        g.fillStyle = s.a; g.fillRect(0, 0, N, N);
        g.fillStyle = s.b;
        for (const [x, y] of [[4, 4], [12, 12]]) { g.beginPath(); g.arc(x, y, 2.3, 0, 7); g.fill(); }
        break;
      case 'checker':
        for (let x = 0; x < N; x += 4) for (let y = 0; y < N; y += 4) { g.fillStyle = ((x + y) / 4) % 2 ? s.a : s.b; g.fillRect(x, y, 4, 4); }
        break;
      case 'camo':
        g.fillStyle = '#6b8e23'; g.fillRect(0, 0, N, N);
        for (const col of ['#3e5c1a', '#8f9a5b', '#4a3b22']) for (let i = 0; i < 4; i++) {
          g.fillStyle = col; g.beginPath(); g.ellipse(rnd() * N, rnd() * N, 2 + rnd() * 4, 1.5 + rnd() * 3, rnd() * 3, 0, 7); g.fill();
        }
        break;
      case 'zebra':
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, N, N);
        g.strokeStyle = '#111'; g.lineWidth = 2.4;
        for (let y = 2; y < N; y += 5) { g.beginPath(); g.moveTo(0, y); g.quadraticCurveTo(N / 2, y + 3, N, y - 1); g.stroke(); }
        break;
      case 'leopard':
        g.fillStyle = '#e8b04a'; g.fillRect(0, 0, N, N);
        for (const [x, y] of [[4, 4], [12, 9], [6, 13]]) {
          g.fillStyle = '#6d4c1d'; g.beginPath(); g.arc(x, y, 2.4, 0, 7); g.fill();
          g.fillStyle = '#2b1d0e'; g.beginPath(); g.arc(x, y, 2.4, 0.4, 2.2); g.lineTo(x, y); g.fill();
        }
        break;
      case 'pixel':
        for (let x = 0; x < N; x += 4) for (let y = 0; y < N; y += 4) { g.fillStyle = ['#2e7d32', '#43a047', '#66bb6a', '#8d6e63'][Math.floor(rnd() * 4)]; g.fillRect(x, y, 4, 4); }
        break;
      case 'denim':
        g.fillStyle = '#3f6fb5'; g.fillRect(0, 0, N, N);
        g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1;
        for (let i = -N; i < N * 2; i += 3) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + N, N); g.stroke(); }
        break;
      case 'marble':
        g.fillStyle = '#f5f5f5'; g.fillRect(0, 0, N, N);
        g.strokeStyle = 'rgba(90,90,90,0.55)'; g.lineWidth = 0.8;
        for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(0, rnd() * N); g.bezierCurveTo(5, rnd() * N, 11, rnd() * N, N, rnd() * N); g.stroke(); }
        break;
      case 'plaid':
        g.fillStyle = '#c62828'; g.fillRect(0, 0, N, N);
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 5, N, 4); g.fillRect(5, 0, 4, N);
        g.fillStyle = 'rgba(255,255,255,0.4)'; g.fillRect(0, 12, N, 1); g.fillRect(12, 0, 1, N);
        break;
      case 'honey':
        g.fillStyle = '#ffb300'; g.fillRect(0, 0, N, N);
        g.strokeStyle = '#e65100'; g.lineWidth = 1;
        for (const [cx, cy] of [[4, 4], [12, 4], [8, 11], [0, 11], [16, 11]]) {
          g.beginPath();
          for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; g.lineTo(cx + Math.cos(a) * 4, cy + Math.sin(a) * 4); }
          g.closePath(); g.stroke();
        }
        break;
      case 'melon':
        g.fillStyle = '#ef5350'; g.fillRect(0, 0, N, N);
        g.fillStyle = '#1b1b1b';
        for (const [x, y] of [[4, 5], [11, 3], [8, 11], [14, 13]]) { g.beginPath(); g.ellipse(x, y, 1, 1.7, 0.4, 0, 7); g.fill(); }
        break;
      case 'galaxy': {
        const gr = g.createLinearGradient(0, 0, N, N);
        gr.addColorStop(0, '#1a0b3d'); gr.addColorStop(0.5, '#4a148c'); gr.addColorStop(1, '#0d47a1');
        g.fillStyle = gr; g.fillRect(0, 0, N, N);
        for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(255,255,255,${0.5 + rnd() * 0.5})`; g.fillRect(rnd() * N, rnd() * N, 1, 1); }
        break;
      }
    }
    const pat = c.createPattern(t, 'repeat');
    patternCache.set(s.id, pat);
    return pat;
  }

  // İmleç ucunu (0,0) orijine koyarak skin'i çiz
  function draw(c, id, time) {
    const s = get(id);
    if (s.kind === 'emoji') {
      // Emoji imleç: uçta küçük renkli ok, yanında emoji (ucun nereyi gösterdiği belli olsun)
      c.save();
      c.beginPath();
      c.moveTo(0, 0); c.lineTo(0, 11); c.lineTo(3, 8.5); c.lineTo(8, 8); c.closePath();
      c.fillStyle = s.color; c.fill();
      c.strokeStyle = INK; c.lineWidth = 1.6; c.lineJoin = 'round'; c.stroke();
      c.translate(13, 13);
      if (s.rot) c.rotate(s.rot);
      c.font = '24px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(s.emoji, 0, 1);
      c.restore();
      return;
    }
    c.save();
    arrowPath(c);
    if (s.kind === 'solid') c.fillStyle = s.color;
    else if (s.kind === 'grad') {
      const g = c.createLinearGradient(0, 0, 12, 26);
      s.stops.forEach((col, i) => g.addColorStop(i / (s.stops.length - 1), col));
      c.fillStyle = g;
    } else c.fillStyle = makePattern(c, s);
    if (s.glow) {
      c.shadowColor = s.glow;
      c.shadowBlur = 10 + (time ? Math.sin(time / 300) * 3 : 0);
    }
    c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = s.outline || INK;
    c.lineWidth = 2.2;
    c.lineJoin = 'round';
    c.stroke();
    c.restore();
  }

  // İsim etiketi rengi (çok açık renklerde okunaklı olsun diye ayrı olabilir)
  const labelColor = (id) => { const s = get(id); return s.label || s.color; };

  return { PAGES, LIST, DEFAULT, get, draw, labelColor, arrowPath };
});
