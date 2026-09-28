// Paylaşılan dünya tanımı: Node'da require('./public/world.js'), tarayıcıda window.WORLD
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WORLD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const W = 3000;
  const H = 2000;
  const SPAWN = { x: 1500, y: 1150 };

  const FIELD = { x: 450, y: 330, w: 1100, h: 640 };
  const GOAL = { depth: 70, mouth: 200 };
  const BALL_R = 22;

  const LAKE = { cx: 2330, cy: 560, rx: 420, ry: 280, mult: 0.45 };
  const RIVER = {
    width: 110,
    speed: 170, // px/sn
    mult: 0.5,
    points: [[1640, -60], [1700, 180], [1860, 300], [1960, 470], [2000, 560]],
  };
  const MUD = { cx: 720, cy: 1560, rx: 330, ry: 190, mult: 0.28 };
  const ICE = { x: 2080, y: 1220, w: 640, h: 480, friction: 0.985 };

  // Kare başına en fazla hareket (px)
  const MAX_STEP = { land: 45, water: 22, ocean: 13, mud: 16 };

  const COLORS = ['#ff5a5f', '#ff9f1c', '#ffd23f', '#3ecf8e', '#2ec4f1', '#4361ee', '#9b5de5', '#f15bb5'];
  const EMOTES = ['👋', '😂', '😮', '❤️', '🔥'];

  // Deterministik süs ağaçları (bölgelere taşmayacak şekilde seçildi)
  const TREES = [
    [120, 140, 38], [260, 90, 30], [90, 420, 34], [220, 700, 40], [110, 980, 32],
    [300, 1180, 36], [140, 1330, 30], [1180, 1500, 34], [1320, 1720, 40], [1520, 1880, 30],
    [1720, 1580, 36], [1880, 1820, 32], [2860, 120, 36], [2900, 960, 34], [2800, 1080, 30],
    [2920, 1840, 38], [1860, 980, 34], [1960, 1110, 30], [1250, 110, 32], [1030, 210, 28],
    [620, 150, 34], [2600, 1900, 30], [2240, 1880, 34], [60, 1850, 36], [420, 1880, 30],
    [1100, 1300, 28], [2860, 760, 32], [1740, 760, 30],
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
    if (inRect(x, y, ICE)) return { kind: 'ice', mult: 1, max: MAX_STEP.land };
    if (inRect(x, y, FIELD)) return { kind: 'grass', mult: 1, max: MAX_STEP.land };
    return { kind: 'sand', mult: 1, max: MAX_STEP.land };
  }

  function isWater(kind) {
    return kind === 'lake' || kind === 'river';
  }

  // Kale ağızlarının y aralığı
  const GOAL_Y1 = FIELD.y + FIELD.h / 2 - GOAL.mouth / 2;
  const GOAL_Y2 = FIELD.y + FIELD.h / 2 + GOAL.mouth / 2;

  return {
    W, H, SPAWN, FIELD, GOAL, GOAL_Y1, GOAL_Y2, BALL_R,
    LAKE, RIVER, MUD, ICE, MAX_STEP, COLORS, EMOTES, TREES,
    terrainAt, riverNearest, inEllipse, inRect, isWater,
  };
});
