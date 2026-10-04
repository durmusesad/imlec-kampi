// Paylaşılan dünya tanımı: Node'da require('./public/world.js'), tarayıcıda window.WORLD
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WORLD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Dünya: eski kamp alanı (3000x2000) + gölün sağında hokey sahası + sağda Istanbul Park yarış pisti bölgesi
  const W = 9450;
  const H = 3520;
  const CAMP_W = 3000;
  const CAMP_H = 2000;
  const SPAWN = { x: 1500, y: 1150 };

  // HaxBall "Classic" stadyumu. Fizik HaxBall birimlerinde (merkez 0,0) hesaplanır,
  // dünyaya S katıyla ölçeklenerek yerleştirilir.
  const HAX = {
    S: 1.5,
    cx: 1000,
    cy: 650,
    width: 420, height: 200, // stadyum yarı ölçüleri (oyuncu sınırı)
    ballAreaX: 370, ballAreaY: 170, // top alanı
    goalY: 64, goalDepth: 30,
    spawnDistance: 170,
    kickOffRadius: 75,
    postRadius: 8,
    player: {
      radius: 15, bCoef: 0.5, invMass: 0.5, damping: 0.96, acceleration: 0.1,
      kickingAcceleration: 0.07, kickingDamping: 0.96, kickStrength: 5, kickback: 0,
    },
    ball: { radius: 10, bCoef: 0.5, invMass: 1, damping: 0.99 },
    kickRange: 4,
    halfSeconds: 60, // devre süresi (2 devre)
    countdownSeconds: 3, // maç ve 2. devre başında geri sayım
    kickoffSeconds: 5, // bu süre sonunda orta yuvarlak herkese açılır
    goalSeconds: 3, // gol kutlaması
    teamMax: 5,
    teams: {
      red: { name: 'Kırmızı', color: '#e56e56' },
      blue: { name: 'Mavi', color: '#5689e5' },
    },
  };
  const toWorld = (x, y) => ({ x: HAX.cx + x * HAX.S, y: HAX.cy + y * HAX.S });

  // Stadyum dünya dikdörtgeni (seyirciler maç sırasında buraya giremez)
  const FIELD = {
    x: HAX.cx - HAX.width * HAX.S,
    y: HAX.cy - HAX.height * HAX.S,
    w: HAX.width * 2 * HAX.S,
    h: HAX.height * 2 * HAX.S,
  };

  // Lobi alanları: stadyumun altında takım seçme ve başlatma yerleri
  const PADS = {
    red: { x: 610, y: 995, w: 200, h: 90 },
    start: { x: 900, y: 995, w: 200, h: 90 },
    blue: { x: 1190, y: 995, w: 200, h: 90 },
  };

  // Plaj voleybolu kortu: kampın altında, pistin solundaki boş kumsal. Fizik voleybol birimlerinde
  // (merkez 0,0; file x=0 çizgisinde), dünyaya S katıyla ölçeklenir. z = yerden yükseklik (aynı birim)
  const VB = {
    S: 1.5,
    cx: 1500,
    cy: 2750,
    courtX: 300, courtY: 150, // saha yarı ölçüleri (çizgiler)
    boundX: 390, boundY: 215, // oyuncuların gidebileceği alan (saha dışı top kurtarmak için pay)
    netH: 44, // file yüksekliği
    netHalf: 165, // file direkten direğe (y yarı uzunluk); dışından geçen top out
    attackLine: 100, // hücum çizgisi (fileden uzaklık)
    spikeZone: 120, // smaç için fileye en fazla bu kadar uzakta olmalısın
    gravity: 0.12,
    reach: 24, // top ile oyuncu kenarı arasındaki vuruş payı
    player: { radius: 15, accel: 0.12, damping: 0.95 },
    dash: { speed: 5, ticks: 10, cooldown: 90, recover: 22 }, // balıklama: hız (birim/tick), süre, bekleme, kalkma
    ball: { radius: 9 },
    teamMax: 5,
    winScore: 11, maxScore: 15, // 11'de 2 farkla, en geç 15'te biter
    countdownSeconds: 3,
    pointSeconds: 2.5,
    serveSeconds: 8, // servis bu sürede atılmazsa otomatik atılır
    teams: {
      red: { name: 'Kırmızı', color: '#e56e56' },
      blue: { name: 'Mavi', color: '#5689e5' },
    },
  };
  const vbToWorld = (x, y) => ({ x: VB.cx + x * VB.S, y: VB.cy + y * VB.S });
  const VFIELD = {
    x: VB.cx - VB.boundX * VB.S, y: VB.cy - VB.boundY * VB.S, w: VB.boundX * 2 * VB.S, h: VB.boundY * 2 * VB.S,
  };
  const VPADS = {
    red: { x: VB.cx - 390, y: VFIELD.y + VFIELD.h + 45, w: 200, h: 90 },
    start: { x: VB.cx - 100, y: VFIELD.y + VFIELD.h + 45, w: 200, h: 90 },
    blue: { x: VB.cx + 190, y: VFIELD.y + VFIELD.h + 45, w: 200, h: 90 },
  };

  // Buz hokeyi sahası: gölün sağında. Fizik hokey birimlerinde (merkez 0,0), dünyaya S katıyla ölçeklenir
  const HK = {
    S: 1.5,
    cx: 3600,
    cy: 600,
    rinkX: 500, rinkY: 220, cornerR: 100, // bantların iç yarı ölçüleri, köşe yarıçapı
    goalX: 420, goalW: 30, goalD: 22, // kale çizgisi (merkezden), kale ağzı yarı genişliği, ağ derinliği
    postRadius: 3,
    blueLine: 140, faceoffRadius: 60,
    spawnDistance: 180,
    // Paten: düşük ivme + çok az sürtünme = kayarak, gecikmeli dönen hareket
    player: {
      radius: 14, bCoef: 0.4, invMass: 0.5, accel: 0.055, damping: 0.988, brake: 1.6,
      shootingAccel: 0.04, shootingDamping: 0.985, shotStrength: 7.5,
    },
    puck: { radius: 5, bCoef: 0.5, invMass: 1.2, damping: 0.997, maxSpeed: 13 },
    shotRange: 5,
    boardsPuck: 0.85, boardsPlayer: 0.35, // bantların sektirme katsayısı
    periods: 3, periodSeconds: 90,
    countdownSeconds: 3, faceoffSeconds: 5, goalSeconds: 3,
    teamMax: 5,
    teams: {
      red: { name: 'Kırmızı', color: '#e56e56' },
      blue: { name: 'Mavi', color: '#5689e5' },
    },
  };
  const hkToWorld = (x, y) => ({ x: HK.cx + x * HK.S, y: HK.cy + y * HK.S });
  // Saha dünya dikdörtgeni (bantlar dahil değil)
  const HFIELD = {
    x: HK.cx - HK.rinkX * HK.S, y: HK.cy - HK.rinkY * HK.S, w: HK.rinkX * 2 * HK.S, h: HK.rinkY * 2 * HK.S,
  };
  const HPADS = {
    red: { x: HK.cx - 390, y: HFIELD.y + HFIELD.h + 50, w: 200, h: 90 },
    start: { x: HK.cx - 100, y: HFIELD.y + HFIELD.h + 50, w: 200, h: 90 },
    blue: { x: HK.cx + 190, y: HFIELD.y + HFIELD.h + 50, w: 200, h: 90 },
  };

  // Tank oyunu (AZ Tank benzeri): buz pistinin altında labirent. Koordinatlar arena içinde piksel (sol üst 0,0)
  const TK = {
    x: 2725, y: 1300, cols: 15, rows: 8, cell: 90, wall: 7,
    tankR: 17, speed: 2.1, backSpeed: 1.5, rot: 0.055, // px/tick, rad/tick
    bulletR: 4, bulletSpeed: 4.2, range: 2520, // menzil: 2520 px / 4.2 px/tick = 600 tick = 10 sn
    maxBullets: 5, grace: 24, // kendi merminin sahibine zarar vermeden alacağı yol (namludan çıkış)
    mines: 2, plantSeconds: 3, mineR: 9, blast: 52,
    mud: 0.45, mudRot: 0.65, // çamurda hız ve dönüş çarpanı
    readySeconds: 1.2, overSeconds: 3, // tur başı bekleme, son kalan belli olduktan sonra bekleme
    maxTanks: 8,
  };
  TK.w = TK.cols * TK.cell;
  TK.h = TK.rows * TK.cell;
  const TFIELD = { x: TK.x, y: TK.y, w: TK.w, h: TK.h };
  const TPADS = {
    join: { x: TK.x + TK.w / 2 - 250, y: TK.y + TK.h + 40, w: 220, h: 90 },
    start: { x: TK.x + TK.w / 2 + 30, y: TK.y + TK.h + 40, w: 220, h: 90 },
  };

  const LAKE = { cx: 2330, cy: 560, rx: 420, ry: 280, mult: 0.45 };
  const RIVER = {
    width: 110,
    speed: 170, // px/sn
    mult: 0.5,
    points: [[1640, -60], [1700, 180], [1860, 300], [1960, 470], [2000, 560]],
  };
  const MUD = { cx: 720, cy: 1560, rx: 330, ry: 190, mult: 0.28 };
  // Gezinirken buz: hokey sahasının kendisi
  const ICE = { ...HFIELD, friction: 0.985 };

  // Kare başına en fazla hareket (px)
  const MAX_STEP = { land: 45, water: 22, ocean: 13, mud: 16 };

  const COLORS = ['#ff5a5f', '#ff9f1c', '#ffd23f', '#3ecf8e', '#2ec4f1', '#4361ee', '#9b5de5', '#f15bb5'];
  // Hızlı emoji menüsünde seçilebilecek emojiler (sunucu da bu listeyle doğrular)
  const EMOJI_PALETTE = [
    '👋', '😂', '😮', '❤️', '🔥', '👍', '👎', '😎', '😭', '😡', '🤔', '🥳', '😴', '🤯', '🙏', '👏',
    '💪', '🎉', '⚽', '🥅', '🏆', '💀', '👀', '🤝', '😅', '🤣', '😱', '🥶', '🫡', '🤡', '💯', '✅',
    '❌', '⭐', '🍿', '🐐', '🚀', '💤', '😇', '🙈',
  ];
  const DEFAULT_QUICK = ['👋', '😂', '😮', '❤️', '🔥', '👍', '😡', '🎉'];
  const CHAT_MAX = 80;

  // Deterministik süs ağaçları (bölgelere taşmayacak şekilde seçildi)
  const TREES = [
    [120, 140, 38], [260, 90, 30], [90, 420, 34], [220, 700, 40], [110, 980, 32],
    [300, 1180, 36], [140, 1330, 30], [1180, 1500, 34], [1320, 1720, 40], [1520, 1880, 30],
    [1720, 1580, 36], [1880, 1820, 32], [2860, 120, 36], [2800, 1080, 30],
    [1860, 980, 34], [1960, 1110, 30], [1250, 110, 32], [1030, 210, 28],
    [620, 150, 34], [2240, 1880, 34], [60, 1850, 36], [420, 1880, 30],
    [1100, 1300, 28], [1740, 760, 30], [2380, 1400, 34],
  ];

  function inEllipse(x, y, e) {
    const dx = (x - e.cx) / e.rx;
    const dy = (y - e.cy) / e.ry;
    return dx * dx + dy * dy <= 1;
  }

  function inRect(x, y, r) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  // Nehir çizgisine en yakın nokta: {d, tx, ty} (t = akıntı yönü birim vektörü)
  function riverNearest(x, y) {
    const pts = RIVER.points;
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      let t = ((x - ax) * vx + (y - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + vx * t, py = ay + vy * t;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) {
        const len = Math.sqrt(len2);
        best = { d, tx: vx / len, ty: vy / len };
      }
    }
    return best;
  }

  // {kind, mult, max, force?} — force px/sn cinsinden akıntı vektörü
  function terrainAt(x, y) {
    if (inEllipse(x, y, LAKE)) return { kind: 'lake', mult: LAKE.mult, max: MAX_STEP.water };
    const r = riverNearest(x, y);
    if (r.d <= RIVER.width / 2) {
      const k = 1 - Math.pow(r.d / (RIVER.width / 2), 2); // ortası daha hızlı
      const s = RIVER.speed * (0.25 + 0.75 * k);
      return { kind: 'river', mult: RIVER.mult, max: MAX_STEP.water, force: { x: r.tx * s, y: r.ty * s } };
    }
    if (inEllipse(x, y, MUD)) return { kind: 'mud', mult: MUD.mult, max: MAX_STEP.mud };
    if (inRink(x, y)) return { kind: 'ice', mult: 1, max: MAX_STEP.land };
    if (inRect(x, y, FIELD)) return { kind: 'grass', mult: 1, max: MAX_STEP.land };
    return { kind: 'sand', mult: 1, max: MAX_STEP.land };
  }

  // Bot ekleme kutuları: her takım alanının altında "+ Bot" / "− Bot", yarışta ayrıca "Doldur".
  // Sunucu ve tarayıcı aynı listeyi kullanır (mesajda sıra numarası gider). TRACK dışarıdan verilir
  function botPadList(TRACK) {
    const under = (pad, x, w) => ({ x, y: pad.y + pad.h + 10, w, h: 36 });
    const list = [];
    for (const [g, P] of [['f', PADS], ['v', VPADS], ['h', HPADS]]) {
      for (const team of ['red', 'blue']) {
        const pad = P[team], w = (pad.w - 10) / 2;
        list.push({ g, team, op: 'add', r: under(pad, pad.x, w) });
        list.push({ g, team, op: 'del', r: under(pad, pad.x + w + 10, w) });
      }
    }
    for (const [g, J, S] of [['r', TRACK.PADS.join, TRACK.PADS.start], ['t', TPADS.join, TPADS.start]]) {
      const w = (J.w - 10) / 2;
      list.push({ g, team: null, op: 'add', r: under(J, J.x, w) });
      list.push({ g, team: null, op: 'del', r: under(J, J.x + w + 10, w) });
      list.push({ g, team: null, op: 'fill', r: under(S, S.x, S.w) });
    }
    return list;
  }

  // Hokey sahasının içi (yuvarlak köşeler dahil), dünya koordinatı
  function inRink(x, y, m = 0) {
    const hx = (x - HK.cx) / HK.S, hy = (y - HK.cy) / HK.S;
    const ix = HK.rinkX - HK.cornerR, iy = HK.rinkY - HK.cornerR;
    const ax = Math.abs(hx), ay = Math.abs(hy);
    if (ax > HK.rinkX + m || ay > HK.rinkY + m) return false;
    if (ax <= ix || ay <= iy) return true;
    return Math.hypot(ax - ix, ay - iy) <= HK.cornerR + m;
  }

  function isWater(kind) {
    return kind === 'lake' || kind === 'river';
  }

  return {
    W, H, CAMP_W, CAMP_H, SPAWN, FIELD, HAX, PADS, toWorld, VB, VFIELD, VPADS, vbToWorld,
    HK, HFIELD, HPADS, hkToWorld, inRink, botPadList, TK, TFIELD, TPADS,
    LAKE, RIVER, MUD, ICE, MAX_STEP, COLORS, EMOJI_PALETTE, DEFAULT_QUICK, CHAT_MAX, TREES,
    terrainAt, riverNearest, inEllipse, inRect, isWater,
  };
});
