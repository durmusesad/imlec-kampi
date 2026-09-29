// Plaj voleybolu motoru (üstten görünüm, topun yüksekliği z ile).
// Sunucu (otoriter) ve tarayıcı (tahmin) aynı kodu çalıştırır. Birimler voleybol birimi, 60 tick/sn.
//
// Vuruşlar: fare yere bir nişan koyar, top o noktaya düşecek şekilde atılır. Ama tam oraya değil:
// vuruşun gücüne, zamanlamasına, koşarken vurulmasına ve gelen topun hızına göre büyüyen bir alanın
// (elips) içinde bir yere düşer. Sert vuruşlar daha çok uzun kaçar. Sapma rastgele ama deterministik
// (tick + oyuncu), böylece tarayıcının tahmini sunucuyla aynı sonucu bulur.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./world.js'));
  else root.VOLLEY = factory(root.WORLD);
})(typeof self !== 'undefined' ? self : this, function (WORLD) {
  'use strict';
  const V = WORLD.VB;
  const P = V.player, B = V.ball;
  const TPS = 60;
  const G = V.gravity;
  const INPUT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, PASS: 16, SPIKE: 32 };
  const PMAX = P.accel / (1 - P.damping); // oyuncunun son hızı
  const REACH = P.radius + B.radius + V.reach;

  // Vuruş türleri: uçuş süresi (tick) = t0 + tk × mesafe; sapma (elips yarı eksenleri) = taban + k × mesafe.
  // bias: sapmanın vuruş yönünde ileri kayması (sert vuruş uzun kaçar)
  const SHOTS = {
    pass: { t0: 48, tk: 0.11, along: 6, alongK: 0.045, lat: 5, latK: 0.03, bias: 0.1 },
    serve: { t0: 50, tk: 0.1, along: 12, alongK: 0.05, lat: 9, latK: 0.03, bias: 0.15 },
    drive: { t0: 26, tk: 0.07, along: 20, alongK: 0.075, lat: 11, latK: 0.035, bias: 0.3 },
    spike: { t0: 14, tk: 0.045, along: 24, alongK: 0.09, lat: 11, latK: 0.04, bias: 0.35 },
  };
  // Topa değilebilecek yükseklik aralığı ve ideal aralık (zamanlama)
  const WINDOW = {
    pass: { min: 0, max: 50, lo: 10, hi: 28, soft: 20 },
    drive: { min: 0, max: 72, lo: 10, hi: 40, soft: 20 },
    spike: { min: 36, max: 72, lo: 46, hi: 62, soft: 10 },
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const other = (team) => (team === 'red' ? 'blue' : 'red');

  // Deterministik rastgele sayı [0, 1)
  function rnd(tick, id, k) {
    let h = (Math.imul(tick | 0, 374761393) + Math.imul((id | 0) + 1, 668265263) + Math.imul(k, 2246822519)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // Zamanlama hatası 0 (ideal) … 1 (çok erken/geç)
  function timingErr(kind, z) {
    const w = WINDOW[kind];
    if (z < w.lo) return clamp((w.lo - z) / w.soft, 0, 1);
    if (z > w.hi) return clamp((z - w.hi) / w.soft, 0, 1);
    return 0;
  }

  // Sapma elipsi: {along, lat, bias} — hem vuruşta hem ekrandaki önizlemede kullanılır
  function spread(kind, dist, o) {
    const s = SHOTS[kind];
    let m = 1;
    m *= 1 + 1.6 * (o.timing || 0);
    m *= 1 + 0.7 * clamp((o.speed || 0) / PMAX, 0, 1);
    m *= 1 + 1.4 * clamp(((o.incoming || 0) - 3) / 6, 0, 1);
    if (o.goodSet) m *= 0.7;
    return { along: (s.along + s.alongK * dist) * m, lat: (s.lat + s.latK * dist) * m, bias: s.bias };
  }

  // z0 yüksekliğinden, T tick sonra (x0,y0)'dan (x1,y1)'e yere düşecek hız
  function launch(ball, x1, y1, T) {
    ball.vx = (x1 - ball.x) / T;
    ball.vy = (y1 - ball.y) / T;
    // Euler adımı: vz -= G; z += vz  →  T adım sonra z = z0 + vz·T − G·T(T+1)/2 = 0
    ball.vz = (G * T * (T + 1) / 2 - ball.z) / T;
  }

  // Tüm uçuşu ileri sar: topun düşeceği yer (file yok sayılır) — ekranda iniş işareti için
  function landing(ball) {
    if (ball.z <= 0 && ball.vz <= 0) return null;
    // z(t) = z + vz·t − G·t(t+1)/2 = 0
    const a = G / 2, b = G / 2 - ball.vz, c = -ball.z;
    const t = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
    return { x: ball.x + ball.vx * t, y: ball.y + ball.vy * t, t };
  }

  class VMatch {
    constructor() {
      this.players = new Map();
      this.ball = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
      this.score = { red: 0, blue: 0 };
      this.tick = 0;
      this.phase = 'countdown'; // countdown | serve | play | point | ended
      this.timer = V.countdownSeconds * TPS;
      this.serveTeam = 'red';
      this.serveIdx = { red: 0, blue: 0 };
      this.server = null;
      this.lastTeam = null; // topa son dokunan takım
      this.lastId = null;
      this.lastTick = 0;
      this.touches = 0; // son dokunan takımın üst üste dokunuş sayısı
      this.goodSet = false; // son dokunuş iyi bir pas mıydı (smaç isabetini artırır)
      this.outCross = false; // top fileyi direklerin dışından geçti
      this.winner = null;
    }

    side(team) {
      return team === 'red' ? -1 : 1;
    }

    addPlayer(id, team) {
      const p = { id, team, x: 0, y: 0, vx: 0, vy: 0, input: 0, ax: 0, ay: 0, ready: true };
      this.players.set(id, p);
      this.place(p);
      return p;
    }

    removePlayer(id) {
      this.players.delete(id);
      if (this.server === id) this.pickServer();
    }

    setInput(id, bits, ax, ay) {
      const p = this.players.get(id);
      if (!p) return;
      p.input = bits & 63;
      if (typeof ax === 'number' && Number.isFinite(ax)) p.ax = clamp(ax, -V.boundX - 150, V.boundX + 150);
      if (typeof ay === 'number' && Number.isFinite(ay)) p.ay = clamp(ay, -V.boundY - 150, V.boundY + 150);
    }

    teamList(team) {
      return [...this.players.values()].filter((p) => p.team === team).sort((a, b) => a.id - b.id);
    }

    place(p) {
      const list = this.teamList(p.team);
      const i = Math.max(0, list.indexOf(p));
      const s = this.side(p.team);
      p.x = s * (i % 2 ? 90 : 190);
      p.y = [-60, 60, 0, -110, 110][i % 5];
      p.vx = p.vy = 0;
    }

    pickServer() {
      const list = this.teamList(this.serveTeam);
      if (!list.length) {
        this.server = null;
        return;
      }
      const sp = list[this.serveIdx[this.serveTeam] % list.length];
      this.server = sp.id;
    }

    startServe() {
      this.phase = 'serve';
      this.timer = V.serveSeconds * TPS;
      this.pickServer();
      const sp = this.players.get(this.server);
      if (sp) {
        sp.x = this.side(sp.team) * (V.courtX + 25);
        sp.y = 0;
        sp.vx = sp.vy = 0;
      }
      this.lastTeam = null;
      this.lastId = null;
      this.touches = 0;
      this.goodSet = false;
      this.outCross = false;
      this.holdBall();
    }

    // Servis bekleyen top, servisçinin önünde havada durur
    holdBall() {
      const b = this.ball, sp = this.players.get(this.server);
      if (!sp) {
        b.x = this.side(this.serveTeam) * (V.courtX + 25);
        b.y = 0;
      } else {
        b.x = sp.x - this.side(sp.team) * 18;
        b.y = sp.y;
      }
      b.z = 26;
      b.vx = b.vy = b.vz = 0;
    }

    step(predict) {
      const ev = [];
      this.tick++;
      if (this.phase === 'ended') return ev;
      if (!predict && !this.players.size) {
        this.finish(ev, 'empty');
        return ev;
      }
      if (this.phase === 'countdown') {
        if (--this.timer <= 0) {
          if (predict) this.timer = 0;
          else {
            this.startServe();
            ev.push({ type: 'serve', team: this.serveTeam, id: this.server });
          }
        }
        return ev;
      }

      this.movePlayers();
      const b = this.ball;

      if (this.phase === 'serve') {
        const sp = this.players.get(this.server);
        if (!sp && !predict) this.pickServer();
        this.holdBall();
        let served = false;
        if (sp) {
          const pass = (sp.input & INPUT.PASS) !== 0, hard = (sp.input & INPUT.SPIKE) !== 0;
          if (!pass && !hard) sp.ready = true;
          else if (sp.ready) {
            sp.ready = false;
            this.hit(sp, hard ? 'drive' : 'serve', ev, true);
            served = true;
          }
        }
        if (!served && !predict && --this.timer <= 0) {
          // Süre doldu: otomatik yumuşak servis rakip sahanın ortasına
          if (sp) {
            sp.ax = -this.side(sp.team) * V.courtX / 2;
            sp.ay = 0;
            this.hit(sp, 'serve', ev, true);
          } else this.startServe();
        }
        if (this.phase === 'serve') return ev;
      }

      if (this.phase === 'play' || this.phase === 'point') {
        if (this.phase === 'play') this.hits(ev);
        this.moveBall(ev, predict);
      }
      if (!predict && this.phase === 'point' && --this.timer <= 0) {
        this.startServe();
        ev.push({ type: 'serve', team: this.serveTeam, id: this.server });
      }
      return ev;
    }

    movePlayers() {
      const list = [...this.players.values()];
      for (const p of list) {
        let dx = 0, dy = 0;
        if (p.input & INPUT.UP) dy -= 1;
        if (p.input & INPUT.DOWN) dy += 1;
        if (p.input & INPUT.LEFT) dx -= 1;
        if (p.input & INPUT.RIGHT) dx += 1;
        if (dx || dy) {
          const l = Math.sqrt(dx * dx + dy * dy);
          p.vx += (dx / l) * P.accel;
          p.vy += (dy / l) * P.accel;
        }
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= P.damping;
        p.vy *= P.damping;
      }
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) discs(list[i], list[j]);
      for (const p of list) {
        const s = this.side(p.team), r = P.radius;
        // Fileyi geçemez; sahanın çevresindeki kumdan dışarı çıkamaz
        if (s * p.x < r) { p.x = s * r; p.vx = 0; }
        if (Math.abs(p.x) > V.boundX - r) { p.x = Math.sign(p.x) * (V.boundX - r); p.vx = 0; }
        if (Math.abs(p.y) > V.boundY - r) { p.y = Math.sign(p.y) * (V.boundY - r); p.vy = 0; }
        // Servisçi dip çizginin gerisinde bekler
        if (this.phase === 'serve' && p.id === this.server && s * p.x < V.courtX + 12) { p.x = s * (V.courtX + 12); p.vx = 0; }
      }
    }

    // Bir oyuncunun vuruş türü: sağ tık/Shift smaç (şartlar uymazsa sert vuruş), sol tık/Space pas
    shotKind(p, z) {
      if (p.input & INPUT.SPIKE) return this.canSpike(p, z) ? 'spike' : 'drive';
      if (p.input & INPUT.PASS) return 'pass';
      return null;
    }

    // Smaç şartları: top yüksekte, oyuncu fileye yakın, topu takım arkadaşı hazırladı (tek kişilik takımda kendisi),
    // nişan rakip sahada
    canSpike(p, z) {
      if (z < WINDOW.spike.min) return false;
      if (Math.abs(p.x) > V.spikeZone) return false;
      if (this.lastTeam !== p.team || this.touches < 1) return false;
      if (this.lastId === p.id && this.teamList(p.team).length > 1) return false;
      return this.side(p.team) * p.ax < 0;
    }

    hits(ev) {
      const b = this.ball;
      let touched = false;
      for (const p of this.players.values()) {
        const kind = this.shotKind(p, b.z);
        if (!kind) {
          p.ready = true;
          continue;
        }
        if (!p.ready || touched) continue;
        const w = WINDOW[kind];
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d > REACH || b.z < w.min || b.z > w.max) continue;
        if (this.side(p.team) * b.x < -B.radius) continue; // file üstünden rakip sahadaki topa uzanılmaz
        if (this.lastId === p.id && this.tick - this.lastTick < 30) continue; // kendi vuruşunun hemen ardından
        p.ready = false;
        touched = true;
        this.hit(p, kind, ev, false);
      }
      if (touched) return;
      // Hiçbir şeye basmayan oyuncuya düşen top gövdeden rastgele seker (dokunuş sayılır)
      for (const p of this.players.values()) {
        const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy);
        if (d > P.radius + B.radius || b.z > 22 || b.vz > 0) continue;
        if (this.lastId === p.id && this.tick - this.lastTick < 20) continue;
        if (!this.touch(p, ev)) return;
        const r1 = rnd(this.tick, p.id, 7), r2 = rnd(this.tick, p.id, 8);
        const a = Math.atan2(dy, dx) + (r1 - 0.5) * 1.6;
        const sp = 0.6 + r2 * 1.4;
        b.vx = Math.cos(a) * sp + p.vx * 0.5;
        b.vy = Math.sin(a) * sp + p.vy * 0.5;
        b.vz = 2 + r2 * 1.2;
        this.goodSet = false;
        ev.push({ type: 'hit', kind: 'body', id: p.id });
        return;
      }
    }

    // Dokunuş kuralları; faul olursa false
    touch(p, ev) {
      if (this.lastTeam === p.team) {
        if (this.lastId === p.id && this.teamList(p.team).length > 1) {
          this.point(other(p.team), 'double', p.id, ev);
          return false;
        }
        this.touches++;
        if (this.touches > 3) {
          this.point(other(p.team), 'touches', p.id, ev);
          return false;
        }
      } else this.touches = 1;
      this.lastTeam = p.team;
      this.lastId = p.id;
      this.lastTick = this.tick;
      return true;
    }

    hit(p, kind, ev, serve) {
      const b = this.ball;
      const incoming = Math.hypot(b.vx, b.vy, b.vz);
      const firstTouch = this.lastTeam !== p.team;
      if (serve) {
        this.phase = 'play';
        this.lastTeam = p.team;
        this.lastId = p.id;
        this.lastTick = this.tick;
        this.touches = 1;
        this.outCross = false;
      } else if (!this.touch(p, ev)) return;
      const s = this.side(p.team);
      let tx = p.ax, ty = p.ay;
      // Servis ve smaç rakip sahaya gider
      if ((serve || kind === 'spike') && s * tx >= 0) tx = -s * V.courtX / 2;
      const dx = tx - b.x, dy = ty - b.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const tErr = serve ? 0 : timingErr(kind === 'serve' ? 'pass' : kind, b.z);
      const sp = spread(kind, dist, {
        timing: tErr,
        speed: Math.hypot(p.vx, p.vy),
        incoming: !serve && firstTouch ? incoming : 0,
        goodSet: kind === 'spike' && this.goodSet,
      });
      // Üçgen dağılım: çoğu vuruş merkeze yakın, azı kenara
      const u = rnd(this.tick, p.id, 1) + rnd(this.tick, p.id, 2) - 1;
      const v = rnd(this.tick, p.id, 3) + rnd(this.tick, p.id, 4) - 1;
      const fx = dx / dist, fy = dy / dist;
      const along = sp.along * (u + sp.bias), lat = sp.lat * v;
      const lx = tx + fx * along - fy * lat, ly = ty + fy * along + fx * lat;
      const sh = SHOTS[kind];
      const T = Math.max(10, Math.round(sh.t0 + sh.tk * Math.hypot(lx - b.x, ly - b.y)));
      if (serve) b.z = 26;
      launch(b, lx, ly, T);
      // Kendi sahasına zamanında atılan pas = smaç için iyi hazırlık
      this.goodSet = kind === 'pass' && tErr < 0.3 && s * tx > 0;
      ev.push({ type: 'hit', kind: serve ? 'serve' : kind, id: p.id, timing: tErr });
    }

    moveBall(ev, predict) {
      const b = this.ball;
      if (b.z <= 0 && b.vz <= 0 && !b.vx && !b.vy) return;
      const px = b.x, pz = b.z;
      b.vz -= G;
      b.x += b.vx;
      b.y += b.vy;
      b.z += b.vz;
      // File: x=0 çizgisini geçerken yeterince yüksek değilse takılır ve geldiği tarafa düşer
      if (px !== 0 && Math.sign(px) !== Math.sign(b.x)) {
        const k = px / (px - b.x);
        const zc = pz + (b.z - pz) * k, yc = b.y - b.vy * (1 - k);
        if (Math.abs(yc) <= V.netHalf) {
          if (zc < V.netH) {
            b.x = Math.sign(px) * B.radius;
            b.vx = -b.vx * 0.2;
            b.vy *= 0.5;
            b.vz = Math.min(b.vz, 0) * 0.5;
            ev.push({ type: 'net' });
          }
        } else this.outCross = true;
      }
      if (b.z <= 0) {
        b.z = 0;
        const vx = b.vx, vy = b.vy;
        b.vx = b.vy = b.vz = 0;
        if (this.phase !== 'play') return;
        if (predict) return;
        ev.push({ type: 'land', speed: Math.hypot(vx, vy) });
        const inCourt = !this.outCross && Math.abs(b.x) <= V.courtX + B.radius * 0.5 && Math.abs(b.y) <= V.courtY + B.radius * 0.5;
        if (inCourt) {
          const sideTeam = b.x < 0 ? 'red' : 'blue';
          this.point(other(sideTeam), 'in', this.lastTeam === other(sideTeam) ? this.lastId : null, ev);
        } else if (this.lastTeam) this.point(other(this.lastTeam), 'out', this.lastId, ev);
        else this.point(other(this.serveTeam), 'out', null, ev);
      }
    }

    point(team, reason, by, ev) {
      if (this.phase !== 'play') return;
      this.score[team]++;
      if (team !== this.serveTeam) {
        this.serveTeam = team;
        this.serveIdx[team]++; // servis el değiştirince sıradaki oyuncu atar
      }
      this.phase = 'point';
      this.timer = Math.round(V.pointSeconds * TPS);
      ev.push({ type: 'point', team, reason, by, score: { ...this.score } });
      const a = this.score.red, c = this.score.blue;
      if ((Math.max(a, c) >= V.winScore && Math.abs(a - c) >= 2) || Math.max(a, c) >= V.maxScore) {
        this.finish(ev, 'score');
      }
    }

    finish(ev, reason) {
      this.phase = 'ended';
      const s = this.score;
      this.winner = s.red > s.blue ? 'red' : s.blue > s.red ? 'blue' : null;
      ev.push({ type: 'end', winner: this.winner, reason, score: { ...s } });
    }

    snapshot(acks) {
      const r = (v) => Math.round(v * 1000) / 1000;
      const p = [];
      for (const q of this.players.values()) {
        const [ack, buf] = acks ? acks(q.id) : [0, 2];
        p.push([q.id, q.team === 'red' ? 0 : 1, r(q.x), r(q.y), r(q.vx), r(q.vy), q.input, q.ready ? 1 : 0, r(q.ax), r(q.ay), ack, buf]);
      }
      const b = this.ball;
      return {
        n: this.tick, ph: this.phase, tmr: this.timer, s: [this.score.red, this.score.blue],
        st: this.serveTeam, si: [this.serveIdx.red, this.serveIdx.blue], sv: this.server,
        lt: this.lastTeam, li: this.lastId, lk: this.lastTick, tc: this.touches, gs: this.goodSet ? 1 : 0, oc: this.outCross ? 1 : 0,
        b: [r(b.x), r(b.y), r(b.z), r(b.vx), r(b.vy), r(b.vz)], p,
      };
    }

    load(g) {
      const seen = new Set();
      for (const [id, t, x, y, vx, vy, input, ready, ax, ay] of g.p) {
        seen.add(id);
        let q = this.players.get(id);
        if (!q) q = this.addPlayer(id, t ? 'blue' : 'red');
        Object.assign(q, { team: t ? 'blue' : 'red', x, y, vx, vy, input, ready: !!ready, ax, ay });
      }
      for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
      const b = this.ball;
      [b.x, b.y, b.z, b.vx, b.vy, b.vz] = g.b;
      this.tick = g.n;
      this.phase = g.ph;
      this.timer = g.tmr;
      this.score = { red: g.s[0], blue: g.s[1] };
      this.serveTeam = g.st;
      this.serveIdx = { red: g.si[0], blue: g.si[1] };
      this.server = g.sv;
      this.lastTeam = g.lt;
      this.lastId = g.li;
      this.lastTick = g.lk;
      this.touches = g.tc;
      this.goodSet = !!g.gs;
      this.outCross = !!g.oc;
    }
  }

  function discs(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, rs = P.radius * 2;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs || d2 === 0) return;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, o = (rs - d) / 2;
    a.x += nx * o; a.y += ny * o;
    b.x -= nx * o; b.y -= ny * o;
    const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (rel < 0) {
      const imp = rel * 0.75;
      a.vx -= nx * imp; a.vy -= ny * imp;
      b.vx += nx * imp; b.vy += ny * imp;
    }
  }

  return { VMatch, INPUT, TPS, SHOTS, WINDOW, REACH, PMAX, spread, timingErr, landing };
});
