'use strict';
// Sunucu botları: her tick oyunun durumuna bakıp gerçek oyuncu gibi tuş (girdi) üretir.
// Aynı fizik motorunu kullandıkları için hile yoktur; sadece tuşlara basarlar.
const WORLD = require('./public/world.js');
const TRACK = require('./public/track.js');
const { landing } = require('./public/volleyball.js');

const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, KICK = 16, SPIKE = 32;

// Vektörden 8 yönlü tuşlar
function dirBits(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  let k = 0;
  if (dx > len * 0.38) k |= RIGHT;
  else if (dx < -len * 0.38) k |= LEFT;
  if (dy > len * 0.38) k |= DOWN;
  else if (dy < -len * 0.38) k |= UP;
  return k;
}

// Hedefe varınca duracak şekilde hız kontrolü: istenen hız ile mevcut hız farkı yönünde bas.
// Buzda (hokey) yavaşlamak da tuşla olur, bu yüzden fren mesafesi hesaba katılır.
function seek(p, tx, ty, vmax, decel) {
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
  const want = Math.min(vmax, Math.sqrt(2 * decel * d) * 0.8);
  const vx = d > 1e-6 ? (dx / d) * want : 0, vy = d > 1e-6 ? (dy / d) * want : 0;
  const ex = vx - p.vx, ey = vy - p.vy;
  if (Math.hypot(ex, ey) < 0.15) return 0;
  return dirBits(ex, ey);
}

// Futbol ve hokey için ortak disk botu
function discAI(m, me, o) {
  const ball = o.ball;
  const side = m.side(me.team); // kendi kalesinin tarafı
  // Nişan kalenin içinde zamanla gezinir: iki bot aynı çizgide kilitlenip topu sıkıştırmasın
  const atk = { x: -side * o.goalX, y: o.goalY * 0.7 * Math.sin(m.tick / 50 + me.id * 1.7) };
  // Hokey: pak rakip kalenin arkasındaysa önce kale önüne çıkar
  if (o.behindNet && Math.sign(ball.x) === -side && Math.abs(ball.x) > o.goalX - 10) atk.x = -side * (o.goalX - 90);
  const team = [...m.players.values()].filter((q) => q.team === me.team);
  team.sort((a, b) => Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y));
  const pr = me.radius, br = ball.radius;
  let gx = atk.x - ball.x, gy = atk.y - ball.y;
  const gl = Math.hypot(gx, gy) || 1;
  gx /= gl;
  gy /= gl;
  let tx, ty, kick = false, loose = false;
  if (team[0] === me) {
    const bx = ball.x - me.x, by = ball.y - me.y, bd = Math.hypot(bx, by) || 1;
    // Top kenara/köşeye sıkıştıysa ya da durgunsa hizalanmayı bekleme: kabaca ileri doğru vur
    const cos = (bx * gx + by * gy) / bd;
    const stuck = Math.abs(ball.x) > o.limX - 15 || Math.abs(ball.y) > o.limY - 15 || Math.hypot(ball.vx, ball.vy) < 0.4;
    loose = me.kickReady && bd - pr - br < o.kickRange && (stuck ? cos > -0.3 : false);
    const along = bx * gx + by * gy, lat = Math.abs(bx * gy - by * gx);
    // Rakip topu karşıdan sıkıştırıyorsa (top durgun) yana sür: kilitlenme çözülsün
    const pinned = Math.hypot(ball.vx, ball.vy) < 0.3 && [...m.players.values()].some((q) => q.team !== me.team &&
      Math.hypot(q.x - ball.x, q.y - ball.y) < q.radius + br + 3);
    if (pinned && bd < pr + br + 6) {
      const sgn = me.id % 2 ? 1 : -1;
      tx = ball.x - gy * sgn * 40;
      ty = ball.y + gx * sgn * 40;
      kick = false;
    } else if (along > 0 && lat < pr * 0.9) {
      // Topun arkasındayım: üstüne sür, hizalıysan vur
      tx = ball.x + gx * 25;
      ty = ball.y + gy * 25;
      kick = bd - pr - br < o.kickRange && cos > 0.8 && me.kickReady;
    } else if (along < 0) {
      // Topun önündeyim: topa çarpmadan yandan dolan
      const nx = -gy, ny = gx;
      const sgn = (me.x - ball.x) * nx + (me.y - ball.y) * ny >= 0 ? 1 : -1;
      const off = pr + br + 18;
      tx = ball.x - gx * off + nx * sgn * off;
      ty = ball.y - gy * off + ny * sgn * off;
    } else {
      tx = ball.x - gx * (pr + br + 4);
      ty = ball.y - gy * (pr + br + 4);
    }
  } else {
    // Destek: top ile kendi kalesi arasında, sıraya göre yana açık
    const i = team.indexOf(me);
    const own = side * o.goalX;
    tx = ball.x + (own - ball.x) * 0.55;
    ty = ball.y * 0.5 + (i % 2 ? 1 : -1) * 45 * Math.ceil(i / 2);
  }
  if (loose) kick = true;
  tx = Math.max(-o.limX, Math.min(o.limX, tx));
  ty = Math.max(-o.limY, Math.min(o.limY, ty));
  return seek(me, tx, ty, o.vmax, o.decel) | (kick ? KICK : 0);
}

function football(m, me) {
  const H = WORLD.HAX;
  return discAI(m, me, {
    ball: m.ball, goalX: H.ballAreaX, goalY: H.goalY, kickRange: H.kickRange, vmax: 2.6, decel: 0.14,
    limX: H.width - 10, limY: H.height - 10,
  });
}

function hockey(m, me) {
  const K = WORLD.HK;
  return discAI(m, me, {
    ball: m.puck, goalX: K.goalX, goalY: K.goalW, kickRange: K.shotRange, vmax: 4.2, decel: K.player.accel * K.player.brake,
    limX: K.rinkX - 20, limY: K.rinkY - 20, behindNet: true,
  });
}

// ---------- Voleybol ----------
const V = WORLD.VB;
const VREACH = V.player.radius + V.ball.radius + V.reach;
function volley(m, me) {
  const s = m.side(me.team);
  const b = m.ball;
  const team = m.teamList(me.team);
  const idx = team.indexOf(me);
  const rnd = () => Math.random() * 2 - 1;
  let bits = 0, ax = -s * V.courtX * 0.5, ay = 0;

  if (m.phase === 'serve') {
    if (m.server === me.id && m.timer < V.serveSeconds * 60 - 50 && me.ready) {
      ax = -s * V.courtX * (0.45 + Math.random() * 0.3);
      ay = rnd() * V.courtY * 0.7;
      bits |= KICK; // pas tuşu = servis
    }
    return { bits, ax, ay };
  }
  // Ev konumu
  let tx = s * (idx % 2 ? 90 : 190), ty = [-60, 60, 0, -110, 110][idx % 5];
  let chasing = false;
  if (m.phase === 'play') {
    const L = b.z > 0 || b.vz > 0 ? landing(b) : { x: b.x, y: b.y };
    const ours = L && s * L.x > 0;
    const out = L && (Math.abs(L.x) > V.courtX + 8 || Math.abs(L.y) > V.courtY + 8);
    const mustPlay = m.lastTeam === me.team; // kendi takımımız dokunduysa dışarı gitse de kurtar
    if (L && ours && (!out || mustPlay)) {
      // Topa en yakın (art arda iki kez dokunamayan hariç) takım arkadaşı koşar
      const cand = team.filter((q) => !(m.lastTeam === me.team && q.id === m.lastId && team.length > 1));
      cand.sort((a, c) => Math.hypot(a.x - L.x, a.y - L.y) - Math.hypot(c.x - L.x, c.y - L.y));
      if (cand[0] === me) {
        tx = L.x + s * 6;
        ty = L.y;
        chasing = true;
      }
    }
    // Topa koşmayan bot alçalan topun yolundan çekilir (gövdeye çarpıp fazla dokunuş olmasın)
    if (!chasing) {
      const dx = me.x - b.x, dy = me.y - b.y, dd = Math.hypot(dx, dy) || 1;
      if (dd < 55 && b.z < 40) {
        tx = me.x + (dx / dd) * 70;
        ty = me.y + (dy / dd) * 70;
      }
    }
    const d = Math.hypot(b.x - me.x, b.y - me.y);
    const canTouch = me.ready && d < VREACH - 3 && s * b.x > -V.ball.radius &&
      !(m.lastId === me.id && (m.tick - m.lastTick < 30 || team.length > 1));
    if (canTouch) {
      const touches = m.lastTeam === me.team ? m.touches : 0;
      if (touches >= 1 && Math.abs(me.x) < V.spikeZone && b.z >= 44 && b.z <= 66) {
        bits |= SPIKE;
        ax = -s * V.courtX * (0.4 + Math.random() * 0.45);
        ay = rnd() * V.courtY * 0.8;
      } else if (b.z >= 6 && b.z <= 34) {
        bits |= KICK;
        if (team.length > 1 && touches < 2) {
          // Fileye yakın, kendi sahamıza pas (hazırlık)
          ax = s * 45;
          ay = rnd() * 40;
        } else {
          ax = -s * V.courtX * (0.45 + Math.random() * 0.35);
          ay = rnd() * V.courtY * 0.7;
        }
      }
    }
  }
  bits |= seek(me, tx, ty, 2.2, 0.12);
  return { bits, ax, ay };
}

// ---------- F1 yarışı ----------
// Önceden hesaplanmış yarış çizgisi (raceline.json): her pist noktası için yanal kayma (n, sol +) ve
// o noktada gidilebilecek hız (px/tick). Çizgi tur süresini en aza indirecek şekilde optimize edildi
// (yol genişliğinin tamamı, çim yok); bot gerçek oyuncu gibi sadece W/A/S/D basar.
// Ölçülen: tek başına uçan tur ≈ 32.7 sn (eski bot ≈ 48 sn).
const RL = require('./raceline.json');
const RACE = require('./public/racing.js');
const LX = new Float64Array(TRACK.N), LY = new Float64Array(TRACK.N);
for (let i = 0; i < TRACK.N; i++) {
  LX[i] = TRACK.X[i] + TRACK.TY[i] * RL.n[i];
  LY[i] = TRACK.Y[i] - TRACK.TX[i] * RL.n[i];
}
const RC_CAR = RACE.CAR, RC_VMAX = Math.sqrt(RC_CAR.accel / RC_CAR.drag);
const BOT_PACE = 1.15, LOOK = 24, LOOK_V = 9, LEAD = 5; // hız katsayısı, bakış mesafesi (px + v·tick), fren öngörüsü
function turnCap(v) {
  return RC_CAR.turnRate * Math.min(1, v / 1.8) * (1 - RC_CAR.turnHighSpeedLoss * Math.min(1, v / RC_VMAX));
}
const mem = new Map(); // araç id -> {stuck, rev}
function race(r, c) {
  if (r.phase !== 'race' && r.phase !== 'finish') return 0;
  if (r.mode === '3d') return race3d(r, c);
  const st = mem.get(c.id) || { stuck: 0, rev: 0 };
  mem.set(c.id, st);
  const N = TRACK.N;
  const v = Math.hypot(c.vx, c.vy);
  // Takılırsa (çarpışma, duvar): kısa süre geri vites, ters direksiyon
  if (st.rev > 0) {
    st.rev--;
    return DOWN | (st.revSteer > 0 ? LEFT : RIGHT);
  }
  // Çizgide en yakın nokta: son bulunan noktadan ileriye doğru ara (virajda çizgi pist merkezinden uzaklaşır)
  if (st.idx == null || Math.hypot(LX[st.idx] - c.x, LY[st.idx] - c.y) > 150) st.idx = c.hint || 0;
  let idx = st.idx, bd = Infinity;
  for (let o = -20; o <= 40; o++) {
    const q = (st.idx + o + N) % N, d = (LX[q] - c.x) ** 2 + (LY[q] - c.y) ** 2;
    if (d < bd) { bd = d; idx = q; }
  }
  st.idx = idx;
  // Önde yakın araç varsa çizginin biraz yanından geç (arkadan çarpmasın)
  let side = 0;
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  for (const o of r.cars.values()) {
    if (o === c) continue;
    const dx = o.x - c.x, dy = o.y - c.y, along = dx * fx + dy * fy, lat = -dx * fy + dy * fx;
    if (along > 0 && along < 40 + v * 12 && Math.abs(lat) < 22 && Math.hypot(o.vx, o.vy) < v + 0.2) {
      side = RL.n[idx] > 0 ? -1 : 1; // yolun ortasına doğru kaç
    }
  }
  // Takip: ileri bakış noktasına yay (pure pursuit) -> istenen direksiyon
  const Ld = LOOK + v * LOOK_V;
  let j = idx, acc = 0;
  while (acc < Ld) { const q = (j + 1) % N; acc += Math.hypot(LX[q] - LX[j], LY[q] - LY[j]); j = q; }
  let tx = LX[j], ty = LY[j];
  if (side) { tx += TRACK.TY[j] * side * 26; ty -= TRACK.TX[j] * side * 26; }
  const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy) || 1;
  let alpha = Math.atan2(dy, dx) - c.a;
  while (alpha > Math.PI) alpha -= Math.PI * 2;
  while (alpha < -Math.PI) alpha += Math.PI * 2;
  st.stuck = v < 0.35 ? st.stuck + 1 : 0;
  if (st.stuck > 90) {
    st.rev = 50;
    st.revSteer = alpha;
    st.stuck = 0;
  }
  const want = Math.max(-1, Math.min(1, ((2 * Math.sin(alpha)) / d) * v / Math.max(1e-4, turnCap(Math.max(v, 0.3)))));
  // Direksiyon yumuşak tepki verir: bir sonraki tick'te istenen değere en yakın tuşu seç
  let bits = 0, be = Infinity;
  for (const [t, b] of [[-1, LEFT], [0, 0], [1, RIGHT]]) {
    const e = Math.abs(c.steer + (t - c.steer) * RC_CAR.steerResponse - want);
    if (e < be) { be = e; bits = b; }
  }
  // Hız: çizginin hız profili (çimdeysen ya da çizgiden çok uzaksan daha temkinli)
  let vt = RL.v[(idx + LEAD) % N] * BOT_PACE;
  if (c.surface === 'grass' || bd > 60 * 60) vt = Math.min(vt, 3.2);
  if (Math.abs(alpha) > 0.9 && v > 2.5) vt = 0;
  if (v < vt) bits |= UP;
  else if (v > vt + 0.04) bits |= DOWN;
  return bits;
}

// 3D yarış botu: gerçek ölçek ve F1 fiziği (racing.js drive3d) için ayrı çizgi (raceline3d.json, yol ±15 px içinde).
// Hız profili 3D fiziğinden; BOT3_PACE 0.97 → uçan tur ≈ 1:24.6 (Istanbul Park gerçek rekoru 1:24.8). 1.0'da ≈ 1:22.6.
const RL3 = require('./raceline3d.json');
const L3X = new Float64Array(TRACK.N), L3Y = new Float64Array(TRACK.N);
for (let i = 0; i < TRACK.N; i++) {
  L3X[i] = TRACK.X[i] + TRACK.TY[i] * RL3.n[i];
  L3Y[i] = TRACK.Y[i] - TRACK.TX[i] * RL3.n[i];
}
const F1 = RACE.F1, MS3 = RACE.MS;
const BOT3_PACE = 0.97, LOOK3 = 20, LOOK3_V = 20, LEAD3 = 3;
const mem3 = new Map();
function race3d(r, c) {
  const st = mem3.get(c.id) || { stuck: 0, rev: 0 };
  mem3.set(c.id, st);
  const N = TRACK.N;
  const v = Math.hypot(c.vx, c.vy), vm = v / MS3;
  if (st.rev > 0) {
    st.rev--;
    return DOWN | (st.revSteer > 0 ? LEFT : RIGHT);
  }
  if (st.idx == null || Math.hypot(L3X[st.idx] - c.x, L3Y[st.idx] - c.y) > 80) st.idx = c.hint || 0;
  let idx = st.idx, bd = Infinity;
  for (let o = -10; o <= 30; o++) {
    const q = (st.idx + o + N) % N, d = (L3X[q] - c.x) ** 2 + (L3Y[q] - c.y) ** 2;
    if (d < bd) { bd = d; idx = q; }
  }
  st.idx = idx;
  // Önde yakın ve yavaş araç: çizginin 3 m yanından geç
  let side = 0;
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  for (const o of r.cars.values()) {
    if (o === c) continue;
    const dx = o.x - c.x, dy = o.y - c.y, along = dx * fx + dy * fy, lat = -dx * fy + dy * fx;
    if (along > 0 && along < 15 + v * 10 && Math.abs(lat) < 6 && Math.hypot(o.vx, o.vy) < v + 0.05) side = RL3.n[idx] > 0 ? -1 : 1;
  }
  const Ld = LOOK3 + v * LOOK3_V;
  let j = idx, acc = 0;
  while (acc < Ld) { const q = (j + 1) % N; acc += Math.hypot(L3X[q] - L3X[j], L3Y[q] - L3Y[j]); j = q; }
  let tx = L3X[j], ty = L3Y[j];
  if (side) { tx += TRACK.TY[j] * side * 8; ty -= TRACK.TX[j] * side * 8; }
  const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy) || 1;
  let al = Math.atan2(dy, dx) - c.a;
  while (al > Math.PI) al -= Math.PI * 2;
  while (al < -Math.PI) al += Math.PI * 2;
  st.stuck = vm < 1.5 ? st.stuck + 1 : 0;
  if (st.stuck > 90) {
    st.rev = 50;
    st.revSteer = al;
    st.stuck = 0;
  }
  // İstenen eğrilik -> direksiyon açısı -> tuş (direksiyon yumuşak döndüğü için bir sonraki tick'e göre seç)
  const kap = (2 * Math.sin(al)) / d / TRACK.V3D.M_PER_PX;
  const lock = F1.maxLock / (1 + (vm / F1.lockSpeed) ** 2);
  const want = Math.max(-1, Math.min(1, Math.atan(kap * F1.wheelbase) / lock));
  let bits = 0, be = Infinity;
  for (const [t, b] of [[-1, LEFT], [0, 0], [1, RIGHT]]) {
    const e = Math.abs(c.steer + (t - c.steer) * F1.steerRate - want);
    if (e < be) { be = e; bits = b; }
  }
  let vt = RL3.v[(idx + LEAD3) % N] * BOT3_PACE;
  if (c.surface === 'grass' || bd > 20 * 20) vt = Math.min(vt, 40 * MS3);
  if (Math.abs(al) > 0.9 && vm > 15) vt = 0;
  if (v < vt) bits |= UP;
  else if (v > vt + 0.02) bits |= DOWN;
  return bits;
}

// ---------- Tank ----------
const TANKS = require('./public/tank.js');
const TK = WORLD.TK;
const MINE = 128;
// Labirentte en kısa yol (hücre hücre); kendi kurulu mayınlarının olduğu hücrelerden kaçınır
function bfs(map, from, to, avoid) {
  const C = TK.cols, R = TK.rows, prev = new Int16Array(C * R).fill(-1);
  const q = [from];
  prev[from] = from;
  const step = [[1, 0, -C], [2, 1, 0], [4, 0, C], [8, -1, 0]];
  while (q.length) {
    const c = q.shift();
    if (c === to) break;
    for (const [bit, dx, dy] of step) {
      if (!(map.open[c] & bit)) continue;
      const n = c + dx + dy;
      if (prev[n] !== -1 || (avoid.has(n) && n !== to)) continue;
      prev[n] = c;
      q.push(n);
    }
  }
  if (prev[to] === -1) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return path;
}
const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
function tank(m, me) {
  if (!me.alive || m.phase === 'ready') return 0;
  const st = mem.get(me.id) || { seen: 0, stuck: 0, rev: 0, lx: me.x, ly: me.y, aim: 0 };
  mem.set(me.id, st);
  if (me.plant > 0) return MINE; // kurulum bitene kadar F basılı
  const map = m.map;
  const foes = m.aliveList().filter((t) => t.id !== me.id);
  if (!foes.length) return 0;
  const C = TK.cols, CELL = TK.cell;
  const here = TANKS.cellOf(me.x, me.y);
  const avoid = new Set(m.mines.filter((x) => x.owner === me.id && x.armed).map((x) => TANKS.cellOf(x.x, x.y)));
  // En yakın rakip (yol uzunluğuna göre)
  let target = null, path = null;
  for (const f of foes) {
    const p = bfs(map, here, TANKS.cellOf(f.x, f.y), avoid);
    if (p && (!path || p.length < path.length)) { path = p; target = f; }
  }
  if (!target) target = foes[0];
  let bits = 0;
  // Geri kaçış (takıldıysa)
  if (st.rev > 0) {
    st.rev--;
    return DOWN | (st.rev % 40 < 20 ? LEFT : RIGHT);
  }
  const see = Math.hypot(target.x - me.x, target.y - me.y) < 900 && TANKS.lineClear(map, me.x, me.y, target.x, target.y, TK.bulletR + 1);
  st.seen = see ? st.seen + 1 : 0;
  if (see) {
    // Görüyorsa dur, dön, nişan alınca ateş et (biraz tepki süresi ve sapma: yenilebilir olsun)
    if (st.seen === 1) st.aim = (Math.random() - 0.5) * 0.12;
    const want = Math.atan2(target.y - me.y, target.x - me.x) + st.aim;
    const d = angDiff(want, me.a);
    if (d > 0.04) bits |= RIGHT;
    else if (d < -0.04) bits |= LEFT;
    if (Math.abs(d) < 0.1 && st.seen > 18 && me.fireReady) bits |= KICK;
    if (Math.hypot(target.x - me.x, target.y - me.y) > 420 && Math.abs(d) < 0.3) bits |= UP;
    return bits;
  }
  // Yolu izle: sıradaki hücrenin merkezine (görüş varsa bir sonrakine) git
  let wp = path && path.length > 1 ? path[1] : here;
  if (path && path.length > 2) {
    const n2 = path[2], x2 = (n2 % C + 0.5) * CELL, y2 = (Math.floor(n2 / C) + 0.5) * CELL;
    if (TANKS.lineClear(map, me.x, me.y, x2, y2, TK.tankR)) wp = n2;
  }
  const wx = (wp % C + 0.5) * CELL, wy = (Math.floor(wp / C) + 0.5) * CELL;
  const d = angDiff(Math.atan2(wy - me.y, wx - me.x), me.a);
  if (d > 0.08) bits |= RIGHT;
  else if (d < -0.08) bits |= LEFT;
  if (Math.abs(d) < 0.45) bits |= UP;
  // Takılma kontrolü
  const moved = Math.hypot(me.x - st.lx, me.y - st.ly);
  st.lx = me.x;
  st.ly = me.y;
  st.stuck = bits & UP && moved < 0.3 ? st.stuck + 1 : 0;
  if (st.stuck > 45) { st.rev = 30; st.stuck = 0; }
  // Arada koridora mayın bırak
  if (me.minesLeft > 0 && me.mineReady && m.phase === 'play' && Math.random() < 1 / 1200) bits = MINE;
  return bits;
}

function forget(id) {
  mem.delete(id);
  mem3.delete(id);
}

module.exports = { football, hockey, volley, race, tank, forget };
