// Buz hokeyi fizik motoru (HaxBall tarzı, buz fiziğiyle).
// Sunucu (otoriter) ve tarayıcı (tahmin) aynı kodu çalıştırır.
// Değerler hokey birimlerinde: merkez (0,0), hız birim/tick, 60 tick/sn. Dünyaya WORLD.HK.S katıyla ölçeklenir.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./world.js'));
  else root.HOCKEY = factory(root.WORLD);
})(typeof self !== 'undefined' ? self : this, function (WORLD) {
  'use strict';
  const HK = WORLD.HK;
  const P = HK.player;
  const B = HK.puck;
  const TPS = 60;
  const SUB = 4; // alt adım: hızlı pak ince kale ağından geçip gitmesin
  const INPUT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, KICK: 16 };

  const RX = HK.rinkX, RY = HK.rinkY, CR = HK.cornerR;
  const GX = HK.goalX, GW = HK.goalW, GD = HK.goalD;

  // Kale ağları: yan ve arka duvarlar (her şeyle çarpışır); ön ağız açık
  const NET = [];
  const MOUTH = []; // kale ağzı: sadece oyuncuları durdurur (oyuncu kalenin içine giremez)
  for (const s of [-1, 1]) {
    NET.push({ x1: s * GX, y1: -GW, x2: s * (GX + GD), y2: -GW, bCoef: 0.15 });
    NET.push({ x1: s * (GX + GD), y1: -GW, x2: s * (GX + GD), y2: GW, bCoef: 0.1 });
    NET.push({ x1: s * (GX + GD), y1: GW, x2: s * GX, y2: GW, bCoef: 0.15 });
    MOUTH.push({ x1: s * GX, y1: -GW, x2: s * GX, y2: GW, bCoef: 0 });
  }
  const POSTS = [];
  for (const s of [-1, 1]) for (const t of [-1, 1]) {
    POSTS.push({ x: s * GX, y: t * GW, vx: 0, vy: 0, radius: HK.postRadius, invMass: 0, bCoef: 0.6 });
  }
  const SPAWN_Y = [0, 60, -60, 120, -120, 170, -170];

  const other = (team) => (team === 'red' ? 'blue' : 'red');

  class HMatch {
    constructor() {
      this.players = new Map();
      this.puck = { x: 0, y: 0, vx: 0, vy: 0, radius: B.radius, invMass: B.invMass, bCoef: B.bCoef };
      this.score = { red: 0, blue: 0 };
      this.period = 1;
      this.ticks = 0; // bu periyotta oynanan süre (tick)
      this.tick = 0;
      // countdown | faceoff | play | goal | break | ended
      this.phase = 'countdown';
      this.timer = HK.countdownSeconds * TPS;
      this.faceoffTeam = 'red';
      this.lastTouch = null;
      this.winner = null;
      this.reason = null;
    }

    // Takımın savunduğu taraf: -1 sol, +1 sağ (her periyotta yer değişir)
    side(team) {
      return (team === 'red' ? -1 : 1) * (this.period % 2 === 0 ? -1 : 1);
    }

    addPlayer(id, team) {
      const p = {
        id, team, x: 0, y: 0, vx: 0, vy: 0,
        radius: P.radius, invMass: P.invMass, bCoef: P.bCoef,
        input: 0, kickReady: true, kicking: false,
      };
      this.players.set(id, p);
      this.placePlayer(p);
      return p;
    }

    removePlayer(id) {
      this.players.delete(id);
      if (this.lastTouch === id) this.lastTouch = null;
    }

    setInput(id, bits) {
      const p = this.players.get(id);
      if (p) p.input = bits & 31;
    }

    teamSize(team) {
      let n = 0;
      for (const p of this.players.values()) if (p.team === team) n++;
      return n;
    }

    placePlayer(p) {
      const same = [...this.players.values()].filter((q) => q.team === p.team);
      const idx = Math.max(0, same.indexOf(p));
      p.x = this.side(p.team) * HK.spawnDistance;
      p.y = SPAWN_Y[idx % SPAWN_Y.length];
      p.vx = p.vy = 0;
    }

    resetPositions() {
      const b = this.puck;
      b.x = b.y = b.vx = b.vy = 0;
      for (const p of this.players.values()) this.placePlayer(p);
      this.lastTouch = null;
    }

    startFaceoff() {
      this.phase = 'faceoff';
      this.timer = HK.faceoffSeconds * TPS;
    }

    touchPuck(p) {
      this.lastTouch = p.id;
      if (this.phase === 'faceoff') this.phase = 'play';
    }

    step(predict) {
      const events = [];
      this.tick++;
      if (this.phase === 'ended') return events;
      if (!predict && !this.teamSize('red') && !this.teamSize('blue')) this.finish(events, 'empty');
      if (this.phase === 'ended') return events;

      if (this.phase === 'countdown' || this.phase === 'break') {
        if (--this.timer <= 0) {
          if (this.phase === 'break') {
            this.phase = 'countdown';
            this.timer = HK.countdownSeconds * TPS;
            if (!predict) events.push({ type: 'countdown' });
          } else {
            this.startFaceoff();
            if (!predict) events.push({ type: 'faceoff' });
          }
        }
        return events;
      }

      const puck = this.puck;
      const live = this.phase === 'play' || this.phase === 'faceoff';

      // 1) Girdi: patenle ivmelenme ve şut
      for (const p of this.players.values()) {
        const kicking = (p.input & INPUT.KICK) !== 0;
        let dx = 0, dy = 0;
        if (p.input & INPUT.UP) dy -= 1;
        if (p.input & INPUT.DOWN) dy += 1;
        if (p.input & INPUT.LEFT) dx -= 1;
        if (p.input & INPUT.RIGHT) dx += 1;
        if (dx || dy) {
          const len = Math.sqrt(dx * dx + dy * dy);
          dx /= len;
          dy /= len;
          let acc = kicking ? P.shootingAccel : P.accel;
          // Hızın tersine basınca paten frenler (hokey duruşu): dönüş biraz daha çabuk ama yine kayarak
          if (p.vx * dx + p.vy * dy < 0) acc *= P.brake;
          p.vx += dx * acc;
          p.vy += dy * acc;
        }
        if (!kicking) {
          p.kickReady = true;
        } else if (p.kickReady) {
          const nx = puck.x - p.x, ny = puck.y - p.y;
          const d = Math.sqrt(nx * nx + ny * ny);
          if (d > 0 && d - p.radius - puck.radius < HK.shotRange) {
            puck.vx += (nx / d) * P.shotStrength;
            puck.vy += (ny / d) * P.shotStrength;
            p.kickReady = false;
            if (live) this.touchPuck(p);
          }
        }
        p.kicking = kicking;
      }

      // 2) Hareket + çarpışmalar (alt adımlarla)
      const list = [...this.players.values()];
      for (let s = 0; s < SUB; s++) {
        for (const p of list) {
          p.x += p.vx / SUB;
          p.y += p.vy / SUB;
        }
        puck.x += puck.vx / SUB;
        puck.y += puck.vy / SUB;
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) discDisc(list[i], list[j]);
          if (discDisc(list[i], puck) && live) this.touchPuck(list[i]);
        }
        for (const post of POSTS) {
          discDisc(puck, post);
          for (const p of list) discDisc(p, post);
        }
        for (const sg of NET) {
          discSegment(puck, sg);
          for (const p of list) discSegment(p, sg);
        }
        for (const sg of MOUTH) for (const p of list) discSegment(p, sg);
        rinkBounds(puck, HK.boardsPuck);
        for (const p of list) {
          rinkBounds(p, HK.boardsPlayer);
          if (this.phase === 'faceoff') this.faceoffBarrier(p);
        }
      }

      // 3) Buz sürtünmesi (çok az)
      for (const p of list) {
        const damp = p.kicking ? P.shootingDamping : P.damping;
        p.vx *= damp;
        p.vy *= damp;
      }
      puck.vx *= B.damping;
      puck.vy *= B.damping;
      const sp = Math.sqrt(puck.vx * puck.vx + puck.vy * puck.vy);
      if (sp > B.maxSpeed) {
        puck.vx *= B.maxSpeed / sp;
        puck.vy *= B.maxSpeed / sp;
      }

      // 4) Kurallar
      if (this.phase === 'faceoff' && --this.timer <= 0) {
        this.phase = 'play';
        if (!predict) events.push({ type: 'faceoffReleased' });
      }
      if (predict) return events;
      if (this.phase === 'play' || this.phase === 'faceoff') {
        if (this.phase === 'play') this.ticks++;
        const ax = Math.abs(puck.x);
        if (ax > GX && ax < GX + GD && Math.abs(puck.y) < GW) {
          const goalAt = puck.x < 0 ? -1 : 1;
          const scored = this.side('red') === goalAt ? 'blue' : 'red';
          this.score[scored]++;
          const toucher = this.lastTouch != null ? this.players.get(this.lastTouch) : null;
          events.push({
            type: 'goal', team: scored, by: toucher ? toucher.id : null,
            own: toucher ? toucher.team !== scored : false, score: { ...this.score },
          });
          this.phase = 'goal';
          this.timer = HK.goalSeconds * TPS;
          this.faceoffTeam = other(scored);
        } else if (this.ticks >= HK.periodSeconds * TPS) {
          this.endPeriod(events);
        }
      } else if (this.phase === 'goal' && --this.timer <= 0) {
        if (this.ticks >= HK.periodSeconds * TPS) this.endPeriod(events);
        else {
          this.resetPositions();
          this.startFaceoff();
          events.push({ type: 'faceoff' });
        }
      }
      return events;
    }

    endPeriod(events) {
      if (this.period < HK.periods) {
        this.period++;
        this.ticks = 0;
        this.faceoffTeam = this.period % 2 === 0 ? 'blue' : 'red';
        this.resetPositions();
        this.phase = 'break';
        this.timer = 2 * TPS;
        events.push({ type: 'period', period: this.period });
      } else {
        this.finish(events, 'time');
      }
    }

    finish(events, reason) {
      this.phase = 'ended';
      this.reason = reason;
      const s = this.score;
      this.winner = s.red > s.blue ? 'red' : s.blue > s.red ? 'blue' : null;
      events.push({ type: 'end', winner: this.winner, reason, score: { ...s } });
    }

    // Başlama: herkes kendi yarısında, rakip takım orta daireye giremez
    faceoffBarrier(p) {
      const side = this.side(p.team);
      const r = p.radius;
      if (p.team === this.faceoffTeam) {
        if (side * p.x < 0 && Math.sqrt(p.x * p.x + p.y * p.y) > HK.faceoffRadius) {
          p.x = 0;
          p.vx = 0;
        }
      } else {
        if (side * p.x < r) {
          p.x = side * r;
          p.vx = 0;
        }
        const d = Math.sqrt(p.x * p.x + p.y * p.y), min = HK.faceoffRadius + r;
        if (d < min) {
          const nx = d > 0 ? p.x / d : side, ny = d > 0 ? p.y / d : 0;
          p.x = nx * min;
          p.y = ny * min;
          const vn = p.vx * nx + p.vy * ny;
          if (vn < 0) {
            p.vx -= nx * vn;
            p.vy -= ny * vn;
          }
        }
      }
    }

    snapshot(acks) {
      const r = (v) => Math.round(v * 1000) / 1000;
      const p = [];
      for (const q of this.players.values()) {
        const [ack, buf] = acks ? acks(q.id) : [0, 2];
        p.push([q.id, q.team === 'red' ? 0 : 1, r(q.x), r(q.y), r(q.vx), r(q.vy), q.input, q.kickReady ? 1 : 0, ack, buf]);
      }
      const b = this.puck;
      return {
        n: this.tick, ph: this.phase, tmr: this.timer, per: this.period, tk: this.ticks,
        s: [this.score.red, this.score.blue], fo: this.faceoffTeam, lt: this.lastTouch,
        b: [r(b.x), r(b.y), r(b.vx), r(b.vy)], p,
      };
    }

    load(g) {
      const seen = new Set();
      for (const [id, t, x, y, vx, vy, input, kr] of g.p) {
        seen.add(id);
        let q = this.players.get(id);
        if (!q) q = this.addPlayer(id, t ? 'blue' : 'red');
        q.team = t ? 'blue' : 'red';
        q.x = x; q.y = y; q.vx = vx; q.vy = vy;
        q.input = input;
        q.kickReady = !!kr;
        q.kicking = (input & INPUT.KICK) !== 0;
      }
      for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
      const b = this.puck;
      [b.x, b.y, b.vx, b.vy] = g.b;
      this.tick = g.n;
      this.phase = g.ph;
      this.timer = g.tmr;
      this.period = g.per;
      this.ticks = g.tk;
      this.score = { red: g.s[0], blue: g.s[1] };
      this.faceoffTeam = g.fo;
      this.lastTouch = g.lt;
    }
  }

  function discDisc(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    const rs = a.radius + b.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs || d2 === 0) return false;
    const inv = a.invMass + b.invMass;
    if (inv === 0) return false;
    const dist = Math.sqrt(d2);
    const nx = dx / dist, ny = dy / dist;
    const ma = a.invMass / inv;
    const overlap = rs - dist;
    a.x += nx * overlap * ma;
    a.y += ny * overlap * ma;
    b.x -= nx * overlap * (1 - ma);
    b.y -= ny * overlap * (1 - ma);
    const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (rel < 0) {
      const imp = rel * (1 + a.bCoef * b.bCoef);
      a.vx -= nx * imp * ma;
      a.vy -= ny * imp * ma;
      b.vx += nx * imp * (1 - ma);
      b.vy += ny * imp * (1 - ma);
    }
    return true;
  }

  function discSegment(d, s) {
    const vx = s.x2 - s.x1, vy = s.y2 - s.y1;
    const len2 = vx * vx + vy * vy;
    let t = ((d.x - s.x1) * vx + (d.y - s.y1) * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = s.x1 + vx * t, cy = s.y1 + vy * t;
    const dx = d.x - cx, dy = d.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= d.radius * d.radius || d2 === 0) return;
    const dist = Math.sqrt(d2);
    const nx = dx / dist, ny = dy / dist;
    d.x = cx + nx * d.radius;
    d.y = cy + ny * d.radius;
    const vn = d.vx * nx + d.vy * ny;
    if (vn < 0) {
      const k = vn * (1 + d.bCoef * s.bCoef);
      d.vx -= nx * k;
      d.vy -= ny * k;
    }
  }

  // Bantlar: köşeleri yuvarlatılmış dikdörtgen (içeriden)
  function rinkBounds(d, bCoef) {
    const r = d.radius;
    const ix = RX - CR, iy = RY - CR;
    const k = 1 + d.bCoef * bCoef;
    const ax = Math.abs(d.x), ay = Math.abs(d.y);
    if (ax > ix && ay > iy) {
      const cx = Math.sign(d.x) * ix, cy = Math.sign(d.y) * iy;
      const dx = d.x - cx, dy = d.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy), max = CR - r;
      if (dist > max) {
        const nx = dx / dist, ny = dy / dist;
        d.x = cx + nx * max;
        d.y = cy + ny * max;
        const vn = d.vx * nx + d.vy * ny;
        if (vn > 0) {
          d.vx -= nx * vn * k;
          d.vy -= ny * vn * k;
        }
      }
      return;
    }
    const bx = RX - r, by = RY - r;
    if (d.x < -bx) { d.x = -bx; if (d.vx < 0) d.vx -= d.vx * k; }
    if (d.x > bx) { d.x = bx; if (d.vx > 0) d.vx -= d.vx * k; }
    if (d.y < -by) { d.y = -by; if (d.vy < 0) d.vy -= d.vy * k; }
    if (d.y > by) { d.y = by; if (d.vy > 0) d.vy -= d.vy * k; }
  }

  return { HMatch, INPUT, TPS };
});
