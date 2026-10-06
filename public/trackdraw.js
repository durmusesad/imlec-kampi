// Istanbul Park pistinin çizimi (Ultimate Racing 2D görünümü): pist bölgesi 512 px'lik parçalara
// bölünür, sadece ekranda görünen parçalar çizilip önbellekte tutulur.
(function (root) {
  'use strict';
  const T = root.TRACK;
  const TILE = 512;
  const RES = 1.6; // parçalar yakın kamera için 1.6 kat çözünürlükte çizilir (bulanık olmasın)
  const INK = '#3b2f24';
  const R = T.REGION;
  const cache = new Map(); // "tx,ty" -> canvas
  const MAX_TILES = 30;

  function rng(seed) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  // Orta çizgiye göre ofsetli nokta (sol normal = (ty, -tx); pozitif ofset sola)
  const ox = (i, off) => T.X[i] + T.TY[i] * off;
  const oy = (i, off) => T.Y[i] - T.TX[i] * off;

  // Tribünler: [başlangıç indeksi oranı, bitiş oranı, taraf (+1 sol/iç, -1 sağ/dış), mesafe]
  const STANDS = [];
  (function () {
    const N = T.N;
    const at = (frac) => Math.floor(frac * N) % N;
    const add = (f0, f1, side, gap) => STANDS.push({ i0: at(f0), i1: at(f1), side, gap });
    add(0.93, 0.995, -1, T.HALF + T.RUNOFF + 14); // ana tribün: start düzlüğü dışı
    add(0.945, 0.99, 1, T.HALF + T.RUNOFF + 14); // pit binası tarafı (iç saha)
    add(0.03, 0.06, -1, T.HALF + T.RUNOFF + 14); // 1. viraj dışı
    add(0.46, 0.5, -1, T.HALF + T.RUNOFF + 14); // 8. viraj dışı
    add(0.62, 0.66, 1, T.HALF + T.RUNOFF + 14); // 9-10 iç
  })();
  const STAND_DEPTH = 58;
  // Çim alanı pistin şeklini izler: iç saha tamamen, dışarıda bariyer ve tribünlerin biraz ötesine kadar
  const GRASS_OUT = T.HALF + T.RUNOFF + 12 + STAND_DEPTH + 70;
  const POLY = [];
  for (let i = 0; i < T.N; i += 3) POLY.push([T.X[i], T.Y[i]]);
  function insideTrack(x, y) {
    let inside = false;
    for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) {
      const [xi, yi] = POLY[i], [xj, yj] = POLY[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function grassPath(c) {
    c.beginPath();
    for (let i = 0; i < POLY.length; i++) (i ? c.lineTo : c.moveTo).call(c, POLY[i][0], POLY[i][1]);
    c.closePath();
  }

  // Ağaçlar: pist bölgesinde, yoldan ve tribünlerden uzak rastgele noktalar
  const TREES = [];
  (function () {
    const r = rng(2024);
    for (let k = 0; k < 900 && TREES.length < 340; k++) {
      const x = R.x + 30 + r() * (R.w - 60), y = R.y + 30 + r() * (R.h - 60);
      const p = T.project(x, y);
      const d = p ? p.dist : Infinity;
      if (d < T.HALF + T.RUNOFF + STAND_DEPTH + 40) continue;
      if (!insideTrack(x, y) && d > GRASS_OUT - 30) continue; // çim alanının dışına ağaç yok
      TREES.push([x, y, 14 + r() * 16, r()]);
    }
  })();

  // Bir çizgiyi (ofsetli orta çizgi) parça sınırları içinde kalan kısımlarıyla çiz
  function strokeOffset(c, off, bx0, by0, bx1, by1, from, to) {
    const N = T.N;
    let drawing = false;
    c.beginPath();
    const count = to == null ? N + 1 : ((to - from + N) % N) + 1;
    for (let k = 0; k < count; k++) {
      const i = ((from || 0) + k) % N;
      const x = ox(i, off), y = oy(i, off);
      const inside = x > bx0 && x < bx1 && y > by0 && y < by1;
      if (inside) {
        if (!drawing) {
          const h = (i - 1 + N) % N;
          c.moveTo(ox(h, off), oy(h, off));
          drawing = true;
        }
        c.lineTo(x, y);
      } else if (drawing) {
        c.lineTo(x, y);
        drawing = false;
      }
    }
    c.stroke();
  }

  function drawTile(tx, ty) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.round(TILE * RES);
    const c = cv.getContext('2d');
    const x0 = R.x + tx * TILE, y0 = R.y + ty * TILE;
    c.scale(RES, RES);
    c.translate(-x0, -y0);
    const M = 140; // çizimlerin taşabileceği pay
    const bx0 = x0 - M, by0 = y0 - M, bx1 = x0 + TILE + M, by1 = y0 + TILE + M;
    const r = rng(tx * 7919 + ty * 104729 + 17);

    // Çim: sadece pistin şeklini izleyen alan (iç saha + dış kenarın biraz ötesi); dışı kamp kumu
    c.lineJoin = 'round';
    c.lineCap = 'round';
    grassPath(c);
    c.strokeStyle = '#cdb67f'; // kumla çimin birleştiği yerde koyu kum kenarı
    c.lineWidth = GRASS_OUT * 2 + 14;
    c.stroke();
    c.fillStyle = '#6aa84f';
    c.strokeStyle = '#6aa84f';
    c.lineWidth = GRASS_OUT * 2;
    c.fill();
    c.stroke();
    // Doku sadece çimin üstüne (source-atop)
    c.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 70; i++) {
      c.fillStyle = r() < 0.5 ? 'rgba(40,90,30,0.07)' : 'rgba(170,210,120,0.07)';
      c.beginPath();
      c.ellipse(x0 + r() * TILE, y0 + r() * TILE, 10 + r() * 40, 6 + r() * 22, r() * 3, 0, Math.PI * 2);
      c.fill();
    }
    c.strokeStyle = 'rgba(30,70,20,0.18)';
    c.lineWidth = 1;
    for (let i = 0; i < 260; i++) {
      const x = x0 + r() * TILE, y = y0 + r() * TILE;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + (r() - 0.5) * 3, y - 3 - r() * 3);
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';

    c.lineJoin = 'round';
    c.lineCap = 'round';

    // Kaçış alanı kenarı: bariyerin önünde koyu çim bandı
    c.strokeStyle = 'rgba(40,80,30,0.25)';
    c.lineWidth = 10;
    for (const s of [1, -1]) strokeOffset(c, s * (T.HALF + T.RUNOFF - 6), bx0, by0, bx1, by1);

    // Lastik bariyerleri: koyu taban + kırmızı/beyaz lastik grupları
    for (const s of [1, -1]) {
      const off = s * (T.HALF + T.RUNOFF + 5);
      c.strokeStyle = '#3a3a3a';
      c.lineWidth = 15;
      strokeOffset(c, off, bx0, by0, bx1, by1);
      for (let i = 0; i < T.N; i++) {
        const x = ox(i, off), y = oy(i, off);
        if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
        const red = Math.floor(i / 3) % 2 === 0;
        for (const d of [-3.4, 3.4]) {
          const px = x + T.TY[i] * d, py = y - T.TX[i] * d;
          c.fillStyle = red ? '#b3261e' : '#e8e8e8';
          c.beginPath();
          c.arc(px, py, 3.2, 0, Math.PI * 2);
          c.fill();
          c.fillStyle = red ? '#5a0f0b' : '#8a8a8a';
          c.beginPath();
          c.arc(px, py, 1.3, 0, Math.PI * 2);
          c.fill();
        }
      }
    }

    // Asfalt: koyu kenar + gri yol + doku
    c.strokeStyle = '#5b5b5f';
    c.lineWidth = T.ROAD_W + 4;
    strokeOffset(c, 0, bx0, by0, bx1, by1);
    c.strokeStyle = '#7b7b80';
    c.lineWidth = T.ROAD_W;
    strokeOffset(c, 0, bx0, by0, bx1, by1);
    // Yol dokusu: yolun üstünde küçük koyu/açık noktalar ve lastik izleri
    c.save();
    c.beginPath();
    c.rect(x0, y0, TILE, TILE);
    c.clip();
    for (let i = 0; i < T.N; i += 1) {
      const x = T.X[i], y = T.Y[i];
      if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
      for (let k = 0; k < 4; k++) {
        const off = (r() - 0.5) * (T.ROAD_W - 8);
        c.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.07)';
        c.fillRect(ox(i, off), oy(i, off), 2, 2);
      }
    }
    c.restore();
    // Yarış çizgisi izi: ortada hafif koyu lastik izi
    c.strokeStyle = 'rgba(40,40,45,0.10)';
    c.lineWidth = 18;
    strokeOffset(c, 0, bx0, by0, bx1, by1);

    // Beyaz kenar çizgileri
    c.strokeStyle = '#f4f4f4';
    c.lineWidth = 2.6;
    for (const s of [1, -1]) strokeOffset(c, s * (T.HALF - 2), bx0, by0, bx1, by1);

    // Kerbler: virajlarda kırmızı/beyaz dişli şerit
    c.lineCap = 'butt';
    for (const s of [1, -1]) {
      const bit = s > 0 ? 1 : 2;
      const off = s * (T.HALF - T.KERB_W / 2);
      for (let i = 0; i < T.N; i++) {
        if (!(T.KERB[i] & bit)) continue;
        const j = (i + 1) % T.N;
        const x = ox(i, off), y = oy(i, off);
        if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
        c.strokeStyle = Math.floor(i / 2) % 2 === 0 ? '#d32f2f' : '#f5f5f5';
        c.lineWidth = T.KERB_W;
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(ox(j, off), oy(j, off));
        c.stroke();
      }
    }
    c.lineCap = 'round';

    // Start/bitiş çizgisi (dama) ve grid kutuları
    const i0 = 0;
    const sx = T.X[i0], sy = T.Y[i0];
    if (sx > bx0 && sx < bx1 && sy > by0 && sy < by1) {
      c.save();
      c.translate(sx, sy);
      c.rotate(Math.atan2(T.TY[i0], T.TX[i0]));
      const sq = 6;
      for (let a = 0; a < 2; a++) {
        for (let b = -T.HALF; b < T.HALF; b += sq) {
          c.fillStyle = (Math.floor((b + T.HALF) / sq) + a) % 2 ? '#111' : '#fff';
          c.fillRect(-sq + a * sq, b, sq, sq);
        }
      }
      c.restore();
    }
    for (let k = 0; k < 12; k++) {
      const g = T.gridSlot(k);
      if (g.x < bx0 || g.x > bx1 || g.y < by0 || g.y > by1) continue;
      c.save();
      c.translate(g.x, g.y);
      c.rotate(g.a);
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(18, -9);
      c.lineTo(18, 9);
      c.moveTo(18, -9);
      c.lineTo(8, -9);
      c.moveTo(18, 9);
      c.lineTo(8, 9);
      c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.8)';
      c.font = 'bold 9px Arial, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.save();
      c.translate(-8, 0);
      c.rotate(Math.PI / 2);
      c.fillText(String(k + 1), 0, 0);
      c.restore();
      c.restore();
    }

    // Tribünler: çatı gölgesi + renkli seyirci sıraları
    for (const st of STANDS) {
      const N = T.N;
      const len = (st.i1 - st.i0 + N) % N;
      for (let k = 0; k < len; k += 3) {
        const i = (st.i0 + k) % N;
        const x = ox(i, st.side * (st.gap + STAND_DEPTH / 2)), y = oy(i, st.side * (st.gap + STAND_DEPTH / 2));
        if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
        c.save();
        c.translate(x, y);
        c.rotate(Math.atan2(T.TY[i], T.TX[i]));
        c.fillStyle = '#9aa3ad';
        c.fillRect(-10, -STAND_DEPTH / 2, 20, STAND_DEPTH);
        // seyirciler: renkli noktalar
        for (let row = 0; row < 6; row++) {
          for (let col = 0; col < 4; col++) {
            const cr = rng(i * 31 + row * 7 + col)();
            c.fillStyle = ['#e53935', '#1e88e5', '#fdd835', '#43a047', '#fb8c00', '#f5f5f5', '#8e24aa'][Math.floor(cr * 7)];
            c.beginPath();
            c.arc(-7.5 + col * 5, -STAND_DEPTH / 2 + 6 + row * 8.5, 1.9, 0, Math.PI * 2);
            c.fill();
          }
        }
        c.restore();
      }
      // çatı: arka kenarda koyu şerit
      c.strokeStyle = '#4a525c';
      c.lineWidth = 8;
      c.lineCap = 'butt';
      strokeOffset(c, st.side * (st.gap + STAND_DEPTH + 2), bx0, by0, bx1, by1, st.i0, st.i1);
      c.lineCap = 'round';
    }

    // Ağaçlar (kampın ağaçlarıyla aynı çizgi stili)
    for (const [x, y, s, v] of TREES) {
      if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
      c.fillStyle = 'rgba(20,50,15,0.25)';
      c.beginPath();
      c.ellipse(x + 7, y + s * 0.8, s * 0.95, s * 0.4, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = INK;
      c.beginPath();
      c.arc(x, y, s + 2.5, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = v < 0.5 ? '#3f8a32' : '#4f9d3a';
      c.beginPath();
      c.arc(x, y, s, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = v < 0.5 ? '#56a845' : '#66b84e';
      c.beginPath();
      c.arc(x - s * 0.3, y - s * 0.3, s * 0.55, 0, Math.PI * 2);
      c.fill();
    }
    return cv;
  }

  let budget = 0;
  function getTile(tx, ty) {
    const key = tx + ',' + ty;
    let t = cache.get(key);
    if (t) {
      cache.delete(key); // LRU: sona taşı
      cache.set(key, t);
      return t;
    }
    if (budget <= 0) return null;
    budget--;
    t = drawTile(tx, ty);
    cache.set(key, t);
    if (cache.size > MAX_TILES) cache.delete(cache.keys().next().value);
    return t;
  }

  // Ekranda görünen pist parçalarını çiz (ctx dünya koordinatında olmalı)
  function draw(ctx, camX, camY, vw, vh) {
    budget = 2; // bir karede en fazla 2 yeni parça üret (takılma olmasın)
    const txs = Math.max(0, Math.floor((camX - R.x) / TILE)), txe = Math.floor((camX + vw - R.x) / TILE);
    const tys = Math.max(0, Math.floor((camY - R.y) / TILE)), tye = Math.floor((camY + vh - R.y) / TILE);
    const maxTx = Math.ceil(R.w / TILE) - 1, maxTy = Math.ceil(R.h / TILE) - 1;
    for (let ty = tys; ty <= Math.min(tye, maxTy); ty++) {
      for (let tx = txs; tx <= Math.min(txe, maxTx); tx++) {
        const t = getTile(tx, ty);
        const x = R.x + tx * TILE, y = R.y + ty * TILE;
        const w = Math.min(TILE, R.x + R.w - x), h = Math.min(TILE, R.y + R.h - y);
        // 1 px üst üste bindir: yakınlaştırmada parça sınırlarında ince çizgi görünmesin
        if (t) ctx.drawImage(t, 0, 0, w * RES, h * RES, x, y, w + 1, h + 1);
      }
    }
  }

  // Boşta kalan zamanlarda parçaları önceden üret (ilk kez gidilen yerde takılma olmasın)
  function prefetch(camX, camY) {
    if (cache.size >= MAX_TILES) return;
    const cx = Math.floor((camX - R.x) / TILE), cy = Math.floor((camY - R.y) / TILE);
    const maxTx = Math.ceil(R.w / TILE) - 1, maxTy = Math.ceil(R.h / TILE) - 1;
    for (let d = 0; d < 4; d++) {
      for (let ty = cy - d; ty <= cy + d + 2; ty++) for (let tx = cx - d; tx <= cx + d + 3; tx++) {
        if (tx < 0 || ty < 0 || tx > maxTx || ty > maxTy || cache.has(tx + ',' + ty)) continue;
        budget = 1;
        getTile(tx, ty);
        return;
      }
    }
  }

  // Mini harita için pist çizgisi
  function drawMini(c, s) {
    c.save();
    c.scale(s, s);
    c.lineJoin = 'round';
    grassPath(c);
    c.fillStyle = '#6aa84f';
    c.strokeStyle = '#6aa84f';
    c.lineWidth = GRASS_OUT * 2;
    c.fill();
    c.stroke();
    c.restore();
    c.save();
    c.strokeStyle = '#555';
    c.lineWidth = Math.max(2, T.ROAD_W * s);
    c.lineJoin = 'round';
    c.beginPath();
    for (let i = 0; i <= T.N; i += 4) {
      const j = i % T.N;
      i ? c.lineTo(T.X[j] * s, T.Y[j] * s) : c.moveTo(T.X[j] * s, T.Y[j] * s);
    }
    c.closePath();
    c.stroke();
    c.restore();
  }

  root.TRACKDRAW = { draw, prefetch, drawMini, TILE, STANDS, STAND_DEPTH, TREES };
})(typeof self !== 'undefined' ? self : this);
