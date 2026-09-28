// Istanbul Park pisti (yarı ölçek): orta çizgi, genişlik, kerbler, kontrol noktaları, grid.
// Sunucu (fizik, tur sayımı) ve tarayıcı (çizim, tahmin) aynı dosyayı kullanır.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TRACK = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Krokiden (1598x1134 görsel) yarış yönünde (saat yönünün tersine) izlenen orta çizgi noktaları.
  // Başlangıç: bitiş çizgisi, sağa doğru (T1'e).
  const RAW = [
    [570, 1013], [640, 1013], [700, 1012], [735, 1004], [748, 985], [748, 950], [745, 910],
    [752, 870], [775, 830], [815, 800], [880, 778], [960, 764], [1040, 762], [1110, 770],
    [1165, 788], [1200, 795], [1235, 780], [1252, 745], [1256, 700], [1262, 668], [1290, 652],
    [1340, 660], [1385, 670], [1408, 655], [1412, 615], [1405, 580], [1380, 555], [1320, 510],
    [1250, 458], [1180, 405], [1120, 358], [1085, 325], [1075, 290], [1090, 262], [1125, 250],
    [1170, 252], [1215, 268], [1290, 302], [1360, 334], [1405, 350], [1450, 345], [1495, 325],
    [1530, 290], [1545, 245], [1530, 200], [1500, 150], [1470, 112], [1430, 97], [1370, 97],
    [1260, 105], [1140, 116], [1030, 128], [960, 138], [935, 155], [930, 185], [942, 220],
    [940, 250], [915, 300], [880, 365], [840, 435], [800, 505], [760, 575], [730, 625],
    [690, 660], [630, 685], [540, 712], [420, 750], [300, 790], [180, 828], [95, 850],
    [72, 868], [80, 890], [108, 898], [132, 905], [140, 925], [130, 960], [115, 990],
    [118, 1008], [150, 1014], [250, 1014], [380, 1014], [480, 1014],
  ];

  const HALF_SCALE_LENGTH = 5338 * 2.5; // 5.338 km, yarı ölçekte 1 m = 2.5 px
  const ROAD_W = 72; // oynanabilirlik için gerçek ölçekten biraz geniş (yan yana ~6 araç)
  const HALF = ROAD_W / 2;
  const KERB_W = 8;
  const RUNOFF = 46; // yol kenarından lastik bariyerine kadar çim/kaçış alanı
  const ORIGIN = { x: 3150, y: 120 }; // pistin dünyadaki sol üst köşesi (gölün ve buz pistinin sağı)

  // Catmull-Rom ile kapalı eğri, sonra düzgün aralıklarla yeniden örnekleme
  function catmull(pts, perSeg) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      for (let s = 0; s < perSeg; s++) {
        const t = s / perSeg, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ]);
      }
    }
    return out;
  }

  function polyLength(pts) {
    let L = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      L += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return L;
  }

  function resample(pts, step) {
    const L = polyLength(pts);
    const n = Math.round(L / step);
    const out = [];
    let seg = 0, segStart = 0;
    const segLen = (i) => { const a = pts[i], b = pts[(i + 1) % pts.length]; return Math.hypot(b[0] - a[0], b[1] - a[1]); };
    for (let k = 0; k < n; k++) {
      const d = (k / n) * L;
      while (segStart + segLen(seg) < d) { segStart += segLen(seg); seg = (seg + 1) % pts.length; }
      const a = pts[seg], b = pts[(seg + 1) % pts.length], l = segLen(seg) || 1;
      const t = (d - segStart) / l;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return out;
  }

  // Keskin köşeleri yumuşat (çok dar viraj yarıçapı yolu kendi içine katlamasın)
  function smooth(pts, iters, k) {
    let p = pts;
    for (let it = 0; it < iters; it++) {
      p = p.map((q, i) => {
        const a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length];
        return [q[0] * (1 - k) + (a[0] + b[0]) * 0.5 * k, q[1] * (1 - k) + (a[1] + b[1]) * 0.5 * k];
      });
    }
    return p;
  }

  // Yarıçapı MIN_RADIUS'tan küçük virajları sadece o bölgede yumuşat (yol iç kenarı katlanmasın)
  const MIN_RADIUS = 62;
  function radiusAt(p, i, w) {
    const n = p.length, a = p[(i - w + n) % n], b = p[i], c = p[(i + w) % n];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    return area2 < 1e-9 ? Infinity : (ab * bc * ca) / (2 * area2);
  }
  function relaxTight(p, minR) {
    for (let it = 0; it < 400; it++) {
      const n = p.length, tight = new Uint8Array(n);
      let any = false;
      for (let i = 0; i < n; i++) if (radiusAt(p, i, 4) < minR) { any = true; for (let o = -10; o <= 10; o++) tight[(i + o + n) % n] = 1; }
      if (!any) break;
      p = p.map((q, i) => {
        if (!tight[i]) return q;
        const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
        return [q[0] * 0.5 + (a[0] + b[0]) * 0.25, q[1] * 0.5 + (a[1] + b[1]) * 0.25];
      });
    }
    return p;
  }

  // 1) krokiyi eğriye çevir, 2) gerçek uzunluğa ölçekle, 3) dünyaya yerleştir
  let pts = catmull(RAW, 12);
  const scale = HALF_SCALE_LENGTH / polyLength(pts);
  let minX = Infinity, minY = Infinity;
  for (const p of pts) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); }
  const MARGIN = HALF + RUNOFF + 260; // tribün/ağaç için yer
  pts = pts.map((p) => [ORIGIN.x + MARGIN + (p[0] - minX) * scale, ORIGIN.y + MARGIN + (p[1] - minY) * scale]);
  pts = resample(pts, 6);
  pts = smooth(pts, 30, 0.5);
  pts = resample(pts, 6);
  pts = relaxTight(pts, MIN_RADIUS);
  pts = resample(pts, 6);

  const N = pts.length;
  const X = new Float64Array(N), Y = new Float64Array(N), TX = new Float64Array(N), TY = new Float64Array(N);
  const S = new Float64Array(N); // orta çizgi boyunca mesafe
  const CURV = new Float64Array(N); // eğrilik (1/yarıçap, işaretli)
  let len = 0;
  for (let i = 0; i < N; i++) {
    X[i] = pts[i][0];
    Y[i] = pts[i][1];
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N, h = (i - 1 + N) % N;
    const dx = X[j] - X[h], dy = Y[j] - Y[h], d = Math.hypot(dx, dy) || 1;
    TX[i] = dx / d;
    TY[i] = dy / d;
    S[i] = len;
    len += Math.hypot(X[j] - X[i], Y[j] - Y[i]);
  }
  const LENGTH = len;
  for (let i = 0; i < N; i++) {
    const j = (i + 3) % N, h = (i - 3 + N) % N;
    const a1 = Math.atan2(TY[i] - 0, TX[i]) ;
    const cross = TX[h] * TY[j] - TY[h] * TX[j];
    const dist = Math.hypot(X[j] - X[h], Y[j] - Y[h]) || 1;
    CURV[i] = (2 * Math.asin(Math.max(-1, Math.min(1, cross)))) / dist;
    void a1;
  }

  // Pist kutusu (dünya koordinatı)
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < N; i++) {
    bx0 = Math.min(bx0, X[i]); by0 = Math.min(by0, Y[i]); bx1 = Math.max(bx1, X[i]); by1 = Math.max(by1, Y[i]);
  }
  const REGION = {
    x: ORIGIN.x, y: ORIGIN.y,
    w: Math.ceil(bx1 + MARGIN - ORIGIN.x), h: Math.ceil(by1 + MARGIN - ORIGIN.y),
  };

  // Hızlı en yakın nokta araması için ızgara indeks
  const CELL = 96;
  const grid = new Map();
  for (let i = 0; i < N; i++) {
    const cx = Math.floor(X[i] / CELL), cy = Math.floor(Y[i] / CELL);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const k = (cx + ox) + ',' + (cy + oy);
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(i);
    }
  }

  // Bir noktanın pistteki yeri: en yakın orta çizgi indeksi, yanal uzaklık (sol +), boyuna konum
  function project(x, y, hint) {
    let best = -1, bd = Infinity;
    if (hint != null && hint >= 0) {
      // Önceki konumun çevresinde ara (araçlar için hızlı yol)
      for (let o = -12; o <= 12; o++) {
        const i = (hint + o + N) % N;
        const d = (X[i] - x) ** 2 + (Y[i] - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      if (bd > (HALF + RUNOFF + 40) ** 2) best = -1;
    }
    if (best < 0) {
      bd = Infinity;
      const a = grid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL));
      if (a) for (const i of a) { const d = (X[i] - x) ** 2 + (Y[i] - y) ** 2; if (d < bd) { bd = d; best = i; } }
      if (best < 0) return null;
    }
    // Komşu iki parça üzerinde tam izdüşüm
    const i = best, j = (i + 1) % N;
    const vx = X[j] - X[i], vy = Y[j] - Y[i], l2 = vx * vx + vy * vy || 1;
    let t = ((x - X[i]) * vx + (y - Y[i]) * vy) / l2;
    t = Math.max(-1, Math.min(1, t));
    const px = X[i] + vx * t, py = Y[i] + vy * t;
    // sol normal = (ty, -tx)
    const lat = (x - px) * TY[i] - (y - py) * TX[i];
    let s = S[i] + t * Math.sqrt(l2);
    if (s < 0) s += LENGTH;
    if (s >= LENGTH) s -= LENGTH;
    return { i, lat, s, dist: Math.abs(lat) };
  }

  // Yüzey: 'road' | 'kerb' | 'grass' | 'wall'
  function surfaceAt(x, y, hint) {
    const p = project(x, y, hint);
    if (!p) return { kind: 'out', p: null };
    const d = p.dist;
    let kind = 'grass';
    if (d <= HALF - KERB_W) kind = 'road';
    else if (d <= HALF + 2 && isKerb(p.i, p.lat)) kind = 'kerb';
    else if (d <= HALF) kind = 'road';
    else if (d >= HALF + RUNOFF) kind = 'wall';
    return { kind, p };
  }

  // Kerbler: belirgin virajların iç ve dış kenarında
  const KERB = new Uint8Array(N); // bit0 sol, bit1 sağ
  (function () {
    const TH = 1 / 260;
    for (let i = 0; i < N; i++) {
      const c = CURV[i];
      if (Math.abs(c) > TH) {
        // Virajın iç ve dış tarafı; birkaç nokta ileri-geri uzat
        for (let o = -8; o <= 8; o++) KERB[(i + o + N) % N] |= 3;
      }
    }
  })();
  function isKerb(i, lat) {
    return lat >= 0 ? !!(KERB[i] & 1) : !!(KERB[i] & 2);
  }

  // Kontrol noktaları (tur sayımı ve kısa yol kesmeye karşı)
  const SECTORS = 16;

  // Start grid: bitiş çizgisinin gerisinde, iki sıra, zikzak
  function gridSlot(k) {
    const back = 40 + k * 26; // piksel
    let s = LENGTH - back;
    let i = 0;
    while (i < N - 1 && S[i + 1] < s) i++;
    const lat = (k % 2 === 0 ? 1 : -1) * HALF * 0.45;
    const x = X[i] + TY[i] * lat, y = Y[i] - TX[i] * lat;
    return { x, y, a: Math.atan2(TY[i], TX[i]), i };
  }

  // Yarış lobisi alanları: start düzlüğünün dışında (bariyerin gerisinde), bitiş çizgisinin hizasında
  const PADS = (function () {
    const sideX = TY[0], sideY = -TX[0]; // sol normal; yarış yönü sağa (doğu) iken sol = kuzey
    const out = -1; // start düzlüğünün güney tarafı (pistin dışı)
    const d = HALF + RUNOFF + 150;
    const cx = X[0] + sideX * d * out, cy = Y[0] + sideY * d * out;
    return {
      join: { x: Math.round(cx - 250), y: Math.round(cy - 45), w: 220, h: 90 },
      start: { x: Math.round(cx + 30), y: Math.round(cy - 45), w: 220, h: 90 },
    };
  })();

  return {
    RAW, N, X, Y, TX, TY, S, CURV, KERB, LENGTH, ROAD_W, HALF, KERB_W, RUNOFF, REGION, SECTORS,
    project, surfaceAt, isKerb, gridSlot, PADS, SCALE: scale,
  };
});
