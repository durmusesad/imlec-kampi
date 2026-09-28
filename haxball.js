'use strict';
// HaxBall fizik motoru ("Classic" stadyum, varsayılan oyuncu/top fiziği).
// Tüm değerler HaxBall birimlerinde: konum birim, hız birim/tick, 60 tick/sn.
const { HAX, toWorld } = require('./public/world.js');

const P = HAX.player;
const B = HAX.ball;
const TICKS_PER_SEC = 60;
const GOAL_CELEBRATION_TICKS = 180; // gol sonrası 3 sn

const INPUT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, KICK: 16 };

// Top alanı ve kale ağları (sadece topla çarpışır)
const AX = HAX.ballAreaX, AY = HAX.ballAreaY, GY = HAX.goalY, GD = HAX.goalDepth;
const BALL_SEGMENTS = [];
function seg(x1, y1, x2, y2, bCoef) {
  BALL_SEGMENTS.push({ x1, y1, x2, y2, bCoef });
}
seg(-AX, -AY, AX, -AY, 1);
seg(-AX, AY, AX, AY, 1);
for (const s of [-1, 1]) {
  seg(s * AX, -AY, s * AX, -GY, 1);
  seg(s * AX, GY, s * AX, AY, 1);
  // Ağ: üst, arka, alt
  seg(s * AX, -GY, s * (AX + GD), -GY, 0.1);
  seg(s * (AX + GD), -GY, s * (AX + GD), GY, 0.1);
  seg(s * (AX + GD), GY, s * AX, GY, 0.1);
}
// Direkler: hareketsiz diskler (invMass 0)
const POSTS = [];
for (const s of [-1, 1]) for (const t of [-1, 1]) {
  POSTS.push({ x: s * AX, y: t * GY, vx: 0, vy: 0, radius: HAX.postRadius, invMass: 0, bCoef: 0.5 });
}
const PLAYER_BOUNDS_BCOEF = 0.1;

const SPAWN_Y = [0, 55, -55, 110, -110, 165, -165];

class Match {
  constructor() {
    this.players = new Map(); // id -> disk
    this.ball = { x: 0, y: 0, vx: 0, vy: 0, radius: B.radius, invMass: B.invMass, bCoef: B.bCoef, damping: B.damping };
    this.score = { red: 0, blue: 0 };
    this.ticks = 0; // oynanan süre (tick)
    this.phase = 'kickoff'; // kickoff | play | goal | ended
    this.kickoffTeam = 'red';
    this.celebrate = 0;
    this.lastTouch = null;
    this.overtime = false;
    this.winner = null;
  }

  addPlayer(id, team) {
    const p = {
      id, team, x: 0, y: 0, vx: 0, vy: 0,
      radius: P.radius, invMass: P.invMass, bCoef: P.bCoef,
      input: 0, kickReady: true,
    };
    this.players.set(id, p);
    this.placePlayer(p);
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
    const idx = same.indexOf(p);
    p.x = (p.team === 'red' ? -1 : 1) * HAX.spawnDistance;
    p.y = SPAWN_Y[idx % SPAWN_Y.length];
    p.vx = p.vy = 0;
  }

  resetPositions() {
    const b = this.ball;
    b.x = b.y = b.vx = b.vy = 0;
    for (const p of this.players.values()) this.placePlayer(p);
    this.phase = 'kickoff';
    this.lastTouch = null;
  }

  touchBall(p) {
    this.lastTouch = p.id;
    if (this.phase === 'kickoff') this.phase = 'play';
  }

  // Bir tick ilerlet; oluşan olayları döndür
  step() {
    const events = [];
    if (this.phase === 'ended') return events;
    const ball = this.ball;
    const inGoal = this.phase === 'goal';

    // 1) Girdi: ivme ve vuruş
    for (const p of this.players.values()) {
      const kicking = (p.input & INPUT.KICK) !== 0;
      let dx = 0, dy = 0;
      if (p.input & INPUT.UP) dy -= 1;
      if (p.input & INPUT.DOWN) dy += 1;
      if (p.input & INPUT.LEFT) dx -= 1;
      if (p.input & INPUT.RIGHT) dx += 1;
      if (dx || dy) {
        const len = Math.hypot(dx, dy);
        const acc = kicking ? P.kickingAcceleration : P.acceleration;
        p.vx += (dx / len) * acc;
        p.vy += (dy / len) * acc;
      }
      if (!kicking) {
        p.kickReady = true;
      } else if (p.kickReady) {
        // Tuş basılıyken top menzile girdiği an vurulur, sonra tuş bırakılana kadar tekrar vurulmaz
        const nx = ball.x - p.x, ny = ball.y - p.y;
        const d = Math.hypot(nx, ny);
        if (d - p.radius - ball.radius < HAX.kickRange && d > 0) {
          ball.vx += (nx / d) * P.kickStrength * ball.invMass;
          ball.vy += (ny / d) * P.kickStrength * ball.invMass;
          p.vx -= (nx / d) * P.kickback * p.invMass;
          p.vy -= (ny / d) * P.kickback * p.invMass;
          p.kickReady = false;
          if (!inGoal) this.touchBall(p);
          events.push({ type: 'kick', id: p.id });
        }
      }
      p.kicking = kicking;
    }

    // 2) Hareket ve sönüm
    for (const p of this.players.values()) {
      p.x += p.vx;
      p.y += p.vy;
      const damp = p.kicking ? P.kickingDamping : P.damping;
      p.vx *= damp;
      p.vy *= damp;
    }
    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.vx *= ball.damping;
    ball.vy *= ball.damping;

    // 3) Çarpışmalar
    const list = [...this.players.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) discDisc(list[i], list[j]);
      if (discDisc(list[i], ball) && !inGoal) this.touchBall(list[i]);
    }
    for (const post of POSTS) {
      discDisc(ball, post);
      for (const p of list) discDisc(p, post);
    }
    for (const s of BALL_SEGMENTS) discSegment(ball, s);
    for (const p of list) {
      playerBounds(p);
      if (this.phase === 'kickoff') this.kickoffBarrier(p);
    }

    // 4) Zaman ve gol
    if (this.phase === 'play') {
      this.ticks++;
      const scored = ball.x < -AX ? 'blue' : ball.x > AX ? 'red' : null;
      if (scored && Math.abs(ball.y) < GY) {
        this.score[scored]++;
        const toucher = this.lastTouch != null ? this.players.get(this.lastTouch) : null;
        events.push({
          type: 'goal', team: scored, by: toucher ? toucher.id : null,
          own: toucher ? toucher.team !== scored : false, score: { ...this.score },
        });
        this.phase = 'goal';
        this.celebrate = GOAL_CELEBRATION_TICKS;
        this.kickoffTeam = scored === 'red' ? 'blue' : 'red';
      } else if (this.ticks >= HAX.timeLimit * TICKS_PER_SEC) {
        if (this.score.red !== this.score.blue) this.finish(events);
        else if (!this.overtime) {
          this.overtime = true;
          events.push({ type: 'overtime' });
        }
      }
    } else if (this.phase === 'goal') {
      if (--this.celebrate <= 0) {
        const s = this.score;
        if (s.red >= HAX.scoreLimit || s.blue >= HAX.scoreLimit || this.overtime ||
            this.ticks >= HAX.timeLimit * TICKS_PER_SEC && s.red !== s.blue) this.finish(events);
        else this.resetPositions();
      }
    }
    return events;
  }

  finish(events) {
    this.phase = 'ended';
    const s = this.score;
    this.winner = s.red > s.blue ? 'red' : s.blue > s.red ? 'blue' : null;
    events.push({ type: 'end', winner: this.winner, score: { ...s } });
  }

  // Başlama vuruşunda: herkes kendi yarısında, rakip takım orta yuvarlağa giremez
  kickoffBarrier(p) {
    const side = p.team === 'red' ? -1 : 1; // kendi yarısı: side * x >= 0
    const r = p.radius;
    if (p.team === this.kickoffTeam) {
      if (side * p.x < 0 && Math.hypot(p.x, p.y) > HAX.kickOffRadius) {
        p.x = 0;
        p.vx = 0;
      }
    } else {
      if (side * p.x < r) {
        p.x = side * r;
        p.vx = 0;
      }
      const d = Math.hypot(p.x, p.y), min = HAX.kickOffRadius + r;
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

  snapshot() {
    const r1 = (v) => Math.round(v * 10) / 10;
    const p = [];
    for (const q of this.players.values()) {
      const w = toWorld(q.x, q.y);
      p.push([q.id, r1(w.x), r1(w.y), q.kicking ? 1 : 0]);
    }
    const b = toWorld(this.ball.x, this.ball.y);
    return {
      p, b: [r1(b.x), r1(b.y)],
      s: [this.score.red, this.score.blue],
      tm: Math.floor(this.ticks / TICKS_PER_SEC),
      ph: this.phase, ot: this.overtime ? 1 : 0, ko: this.kickoffTeam,
    };
  }
}

// HaxBall disk-disk çarpışması
function discDisc(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  const dist = Math.hypot(dx, dy);
  const rs = a.radius + b.radius;
  if (dist >= rs || dist === 0) return false;
  const inv = a.invMass + b.invMass;
  if (inv === 0) return false;
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
  const dist = Math.hypot(dx, dy);
  if (dist >= d.radius || dist === 0) return;
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

function playerBounds(p) {
  const bx = HAX.width - p.radius, by = HAX.height - p.radius;
  const k = 1 + p.bCoef * PLAYER_BOUNDS_BCOEF;
  if (p.x < -bx) { p.x = -bx; if (p.vx < 0) p.vx -= p.vx * k; }
  if (p.x > bx) { p.x = bx; if (p.vx > 0) p.vx -= p.vx * k; }
  if (p.y < -by) { p.y = -by; if (p.vy < 0) p.vy -= p.vy * k; }
  if (p.y > by) { p.y = by; if (p.vy > 0) p.vy -= p.vy * k; }
}

module.exports = { Match, INPUT, TICKS_PER_SEC };
