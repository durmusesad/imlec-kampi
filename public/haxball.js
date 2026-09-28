// HaxBall fizik motoru ("Classic" stadyum, varsayılan oyuncu/top fiziği).
// Sunucu (otoriter) ve tarayıcı (tahmin) aynı kodu çalıştırır.
// Tüm değerler HaxBall birimlerinde: konum birim, hız birim/tick, 60 tick/sn.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./world.js'));
  else root.HAXBALL = factory(root.WORLD);
})(typeof self !== 'undefined' ? self : this, function (WORLD) {
  'use strict';
  const HAX = WORLD.HAX;
  const P = HAX.player;
  const B = HAX.ball;
  const TPS = 60;
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

  const other = (team) => (team === 'red' ? 'blue' : 'red');

  class Match {
    constructor() {
      this.players = new Map(); // id -> disk
      this.ball = { x: 0, y: 0, vx: 0, vy: 0, radius: B.radius, invMass: B.invMass, bCoef: B.bCoef };
      this.score = { red: 0, blue: 0 };
      this.half = 1;
      this.ticks = 0; // bu devrede oynanan süre (tick)
      this.tick = 0; // toplam simülasyon adımı
      // countdown | kickoff | play | goal | halftime | ended
      this.phase = 'countdown';
      this.timer = HAX.countdownSeconds * TPS; // aşama sayacı
      this.kickoffTeam = 'red';
      this.firstKickoff = 'red';
      this.lastTouch = null;
      this.forfeit = 0; // boş takım bekleme sayacı
      this.winner = null;
      this.reason = null;
    }

    // Takımın saha tarafı: -1 sol, +1 sağ (2. devrede yer değişir)
    side(team) {
      return (team === 'red' ? -1 : 1) * (this.half === 2 ? -1 : 1);
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
      p.x = this.side(p.team) * HAX.spawnDistance;
      p.y = SPAWN_Y[idx % SPAWN_Y.length];
      p.vx = p.vy = 0;
    }

    resetPositions() {
      const b = this.ball;
      b.x = b.y = b.vx = b.vy = 0;
      for (const p of this.players.values()) this.placePlayer(p);
      this.lastTouch = null;
    }

    startKickoff() {
      this.phase = 'kickoff';
      this.timer = HAX.kickoffSeconds * TPS;
    }

    touchBall(p) {
      this.lastTouch = p.id;
      if (this.phase === 'kickoff') this.phase = 'play';
    }

    // Bir tick ilerlet; oluşan olayları döndür. predict=true: istemci tahmini (kural olayları yok)
    step(predict) {
      const events = [];
      this.tick++;
      if (this.phase === 'ended') return events;

      if (!predict) this.checkTeams(events);
      if (this.phase === 'ended') return events;

      if (this.phase === 'countdown' || this.phase === 'halftime') {
        // Herkes yerinde donar
        if (!predict && --this.timer <= 0) {
          if (this.phase === 'halftime') {
            this.phase = 'countdown';
            this.timer = HAX.countdownSeconds * TPS;
            events.push({ type: 'countdown' });
          } else {
            this.startKickoff();
            events.push({ type: 'kickoff' });
          }
        }
        return events;
      }

      const ball = this.ball;
      const live = this.phase === 'play' || this.phase === 'kickoff';

      // 1) Girdi: ivme ve vuruş
      for (const p of this.players.values()) {
        const kicking = (p.input & INPUT.KICK) !== 0;
        let dx = 0, dy = 0;
        if (p.input & INPUT.UP) dy -= 1;
        if (p.input & INPUT.DOWN) dy += 1;
        if (p.input & INPUT.LEFT) dx -= 1;
        if (p.input & INPUT.RIGHT) dx += 1;
        if (dx || dy) {
          const len = Math.sqrt(dx * dx + dy * dy);
          const acc = kicking ? P.kickingAcceleration : P.acceleration;
          p.vx += (dx / len) * acc;
          p.vy += (dy / len) * acc;
        }
        if (!kicking) {
          p.kickReady = true;
        } else if (p.kickReady) {
          // Tuş basılıyken top menzile girdiği an vurulur; tekrar vurmak için tuş bırakılmalı
          const nx = ball.x - p.x, ny = ball.y - p.y;
          const d = Math.sqrt(nx * nx + ny * ny);
          if (d > 0 && d - p.radius - ball.radius < HAX.kickRange) {
            ball.vx += (nx / d) * P.kickStrength * ball.invMass;
            ball.vy += (ny / d) * P.kickStrength * ball.invMass;
            p.vx -= (nx / d) * P.kickback * p.invMass;
            p.vy -= (ny / d) * P.kickback * p.invMass;
            p.kickReady = false;
            if (live) this.touchBall(p);
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
      ball.vx *= B.damping;
      ball.vy *= B.damping;

      // 3) Çarpışmalar
      const list = [...this.players.values()];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) discDisc(list[i], list[j]);
        if (discDisc(list[i], ball) && live) this.touchBall(list[i]);
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

      if (predict) return events;

      // 4) Kurallar: başlama süresi, zaman, gol, devre
      if (this.phase === 'kickoff' && --this.timer <= 0) {
        this.phase = 'play'; // 5 sn içinde başlama yapılmazsa orta yuvarlak herkese açılır
        events.push({ type: 'kickoffReleased' });
      }
      if (this.phase === 'play' || this.phase === 'kickoff') {
        if (this.phase === 'play') this.ticks++;
        const goalAt = ball.x < -AX ? -1 : ball.x > AX ? 1 : 0;
        if (goalAt && Math.abs(ball.y) < GY) {
          // Topun girdiği kale, o tarafı savunan takımındır
          const scored = this.side('red') === goalAt ? 'blue' : 'red';
          this.score[scored]++;
          const toucher = this.lastTouch != null ? this.players.get(this.lastTouch) : null;
          events.push({
            type: 'goal', team: scored, by: toucher ? toucher.id : null,
            own: toucher ? toucher.team !== scored : false, score: { ...this.score },
          });
          this.phase = 'goal';
          this.timer = HAX.goalSeconds * TPS;
          this.kickoffTeam = other(scored);
        } else if (this.ticks >= HAX.halfSeconds * TPS) {
          this.endHalf(events);
        }
      } else if (this.phase === 'goal' && --this.timer <= 0) {
        if (this.ticks >= HAX.halfSeconds * TPS) this.endHalf(events);
        else {
          this.resetPositions();
          this.startKickoff();
          events.push({ type: 'kickoff' });
        }
      }
      return events;
    }

    endHalf(events) {
      if (this.half === 1) {
        this.half = 2;
        this.ticks = 0;
        this.kickoffTeam = other(this.firstKickoff);
        this.resetPositions();
        this.phase = 'halftime';
        this.timer = 2 * TPS;
        events.push({ type: 'halftime' });
      } else {
        this.finish(events, 'time');
      }
    }

    // Bir takım boşalırsa bekle; süre dolarsa hükmen bitir
    checkTeams(events) {
      const r = this.teamSize('red'), b = this.teamSize('blue');
      if (!r && !b) return this.finish(events, 'empty');
      if (r && b) {
        this.forfeit = 0;
        return;
      }
      this.forfeit++;
      if (this.forfeit >= HAX.forfeitSeconds * TPS) {
        this.winner = r ? 'red' : 'blue';
        this.finish(events, 'forfeit', this.winner);
      }
    }

    finish(events, reason, winner) {
      this.phase = 'ended';
      this.reason = reason;
      const s = this.score;
      this.winner = winner || (s.red > s.blue ? 'red' : s.blue > s.red ? 'blue' : null);
      events.push({ type: 'end', winner: this.winner, reason, score: { ...s } });
    }

    // Başlama vuruşu: herkes kendi yarısında, rakip takım orta yuvarlağa giremez
    kickoffBarrier(p) {
      const side = this.side(p.team); // kendi yarısı: side * x >= 0
      const r = p.radius;
      if (p.team === this.kickoffTeam) {
        if (side * p.x < 0 && Math.sqrt(p.x * p.x + p.y * p.y) > HAX.kickOffRadius) {
          p.x = 0;
          p.vx = 0;
        }
      } else {
        if (side * p.x < r) {
          p.x = side * r;
          p.vx = 0;
        }
        const d = Math.sqrt(p.x * p.x + p.y * p.y), min = HAX.kickOffRadius + r;
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

    // Ağ üzerinden gönderilen tam durum (HaxBall birimleri)
    snapshot(acks) {
      const r = (v) => Math.round(v * 1000) / 1000;
      const p = [];
      for (const q of this.players.values()) {
        const [ack, buf] = acks ? acks(q.id) : [0, 2];
        p.push([q.id, q.team === 'red' ? 0 : 1, r(q.x), r(q.y), r(q.vx), r(q.vy), q.input, q.kickReady ? 1 : 0, ack, buf]);
      }
      const b = this.ball;
      return {
        n: this.tick, ph: this.phase, tmr: this.timer, half: this.half, tk: this.ticks,
        s: [this.score.red, this.score.blue], ko: this.kickoffTeam, ff: this.forfeit,
        b: [r(b.x), r(b.y), r(b.vx), r(b.vy)], p,
      };
    }

    // İstemci: sunucudan gelen durumu yükle
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
      const b = this.ball;
      [b.x, b.y, b.vx, b.vy] = g.b;
      this.tick = g.n;
      this.phase = g.ph;
      this.timer = g.tmr;
      this.half = g.half;
      this.ticks = g.tk;
      this.score = { red: g.s[0], blue: g.s[1] };
      this.kickoffTeam = g.ko;
      this.forfeit = g.ff;
    }
  }

  // HaxBall disk-disk çarpışması
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

  function playerBounds(p) {
    const bx = HAX.width - p.radius, by = HAX.height - p.radius;
    const k = 1 + p.bCoef * PLAYER_BOUNDS_BCOEF;
    if (p.x < -bx) { p.x = -bx; if (p.vx < 0) p.vx -= p.vx * k; }
    if (p.x > bx) { p.x = bx; if (p.vx > 0) p.vx -= p.vx * k; }
    if (p.y < -by) { p.y = -by; if (p.vy < 0) p.vy -= p.vy * k; }
    if (p.y > by) { p.y = by; if (p.vy > 0) p.vy -= p.vy * k; }
  }

  return { Match, INPUT, TPS };
});
