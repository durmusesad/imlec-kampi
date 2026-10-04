// Tank oyunu motoru (AZ Tank benzeri): labirent, duvardan seken mermiler, mayınlar, son kalan puan alır.
// Sunucu (otoriter) ve tarayıcı (tahmin) aynı kodu çalıştırır. Koordinatlar arena içinde piksel, 60 tick/sn.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./world.js'));
  else root.TANKS = factory(root.WORLD);
})(typeof self !== 'undefined' ? self : this, function (WORLD) {
  'use strict';
  const T = WORLD.TK;
  const TPS = 60;
  const INPUT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16, MINE: 128 };
  const C = T.cols, R = T.rows, CELL = T.cell, WT = T.wall;
  const N = 1, E = 2, S = 4, Wd = 8; // hücre açıklıkları
  const SUB = 3; // mermi alt adımı (ince duvardan geçip gitmesin)

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Tohumdan labirent + çamur alanları. Aynı tohum her yerde aynı haritayı verir
  const mapCache = new Map();
  function buildMap(seed) {
    if (mapCache.has(seed)) return mapCache.get(seed);
    const r = rng(seed);
    const open = new Uint8Array(C * R);
    const idx = (c, rr) => rr * C + c;
    // Derinlik öncelikli labirent
    const seen = new Uint8Array(C * R);
    const stack = [[Math.floor(r() * C), Math.floor(r() * R)]];
    seen[idx(stack[0][0], stack[0][1])] = 1;
    const dirs = [[0, -1, N, S], [1, 0, E, Wd], [0, 1, S, N], [-1, 0, Wd, E]];
    while (stack.length) {
      const [c, rr] = stack[stack.length - 1];
      const nb = dirs.filter(([dx, dy]) => {
        const x = c + dx, y = rr + dy;
        return x >= 0 && y >= 0 && x < C && y < R && !seen[idx(x, y)];
      });
      if (!nb.length) {
        stack.pop();
        continue;
      }
      const [dx, dy, a, b] = nb[Math.floor(r() * nb.length)];
      open[idx(c, rr)] |= a;
      open[idx(c + dx, rr + dy)] |= b;
      seen[idx(c + dx, rr + dy)] = 1;
      stack.push([c + dx, rr + dy]);
    }
    // Döngüler: bazı iç duvarları kaldır (AZ'deki gibi açık, dolaşılabilir labirent)
    for (let rr = 0; rr < R; rr++) for (let c = 0; c < C; c++) {
      if (c < C - 1 && !(open[idx(c, rr)] & E) && r() < 0.28) { open[idx(c, rr)] |= E; open[idx(c + 1, rr)] |= Wd; }
      if (rr < R - 1 && !(open[idx(c, rr)] & S) && r() < 0.28) { open[idx(c, rr)] |= S; open[idx(c, rr + 1)] |= N; }
    }
    // Duvar dikdörtgenleri (bitişik parçalar birleştirilir)
    const walls = [];
    for (let rr = 0; rr <= R; rr++) {
      let start = -1;
      for (let c = 0; c <= C; c++) {
        const has = c < C && (rr === 0 || rr === R || !(open[idx(c, rr)] & N));
        if (has && start < 0) start = c;
        if (!has && start >= 0) {
          walls.push({ x: start * CELL - WT / 2, y: rr * CELL - WT / 2, w: (c - start) * CELL + WT, h: WT });
          start = -1;
        }
      }
    }
    for (let c = 0; c <= C; c++) {
      let start = -1;
      for (let rr = 0; rr <= R; rr++) {
        const has = rr < R && (c === 0 || c === C || !(open[idx(c, rr)] & Wd));
        if (has && start < 0) start = rr;
        if (!has && start >= 0) {
          walls.push({ x: c * CELL - WT / 2, y: start * CELL - WT / 2, w: WT, h: (rr - start) * CELL + WT });
          start = -1;
        }
      }
    }
    // Hızlı arama için: her hücreye yakın duvarlar
    const near = [];
    for (let rr = 0; rr < R; rr++) for (let c = 0; c < C; c++) {
      const x0 = c * CELL - CELL * 0.5, y0 = rr * CELL - CELL * 0.5, x1 = x0 + CELL * 2, y1 = y0 + CELL * 2;
      near.push(walls.filter((w) => w.x < x1 && w.x + w.w > x0 && w.y < y1 && w.y + w.h > y0));
    }
    // Çamur: rastgele koridorlarda (iki açık komşu hücre arasında uzanan leke)
    const mud = [];
    const count = 4 + Math.floor(r() * 3);
    for (let k = 0; k < count * 4 && mud.length < count; k++) {
      const c = Math.floor(r() * C), rr = Math.floor(r() * R);
      const o = open[idx(c, rr)];
      const opts = [[E, 1, 0], [S, 0, 1]].filter(([b]) => o & b);
      if (!opts.length) continue;
      const [, dx, dy] = opts[Math.floor(r() * opts.length)];
      const cx = (c + 0.5 + dx * 0.5) * CELL, cy = (rr + 0.5 + dy * 0.5) * CELL;
      if (mud.some((m) => Math.hypot(m.cx - cx, m.cy - cy) < CELL * 2)) continue;
      mud.push({ cx, cy, rx: dx ? CELL * 0.85 : CELL * 0.4, ry: dy ? CELL * 0.85 : CELL * 0.4, seed: Math.floor(r() * 1e6) });
    }
    const map = { seed, open, walls, near, mud };
    mapCache.set(seed, map);
    if (mapCache.size > 8) mapCache.delete(mapCache.keys().next().value);
    return map;
  }

  function cellOf(x, y) {
    const c = Math.max(0, Math.min(C - 1, Math.floor(x / CELL)));
    const rr = Math.max(0, Math.min(R - 1, Math.floor(y / CELL)));
    return rr * C + c;
  }

  function inMud(map, x, y) {
    for (const m of map.mud) {
      const dx = (x - m.cx) / m.rx, dy = (y - m.cy) / m.ry;
      if (dx * dx + dy * dy <= 1) return true;
    }
    return false;
  }

  // Daire-dikdörtgen: içe girmişse dışarı it, normali döndür
  function pushOut(o, rad, w) {
    const cx = Math.max(w.x, Math.min(o.x, w.x + w.w)), cy = Math.max(w.y, Math.min(o.y, w.y + w.h));
    let dx = o.x - cx, dy = o.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rad * rad) return null;
    let d = Math.sqrt(d2);
    if (d === 0) {
      // Merkez duvarın içinde: en kısa çıkış yönü
      const l = o.x - w.x, rt = w.x + w.w - o.x, t = o.y - w.y, b = w.y + w.h - o.y;
      const m = Math.min(l, rt, t, b);
      if (m === l) { dx = -1; dy = 0; d = -l; } else if (m === rt) { dx = 1; dy = 0; d = -rt; } else if (m === t) { dx = 0; dy = -1; d = -t; } else { dx = 0; dy = 1; d = -b; }
      o.x += dx * (rad - d);
      o.y += dy * (rad - d);
      return { nx: dx, ny: dy };
    }
    const nx = dx / d, ny = dy / d;
    o.x += nx * (rad - d);
    o.y += ny * (rad - d);
    return { nx, ny };
  }

  // Bir noktadan diğerine duvara çarpmadan görüş var mı (botlar için)
  function lineClear(map, x0, y0, x1, y1, pad = 2) {
    const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 6);
    for (let i = 1; i < n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      for (const w of map.near[cellOf(x, y)]) {
        if (x > w.x - pad && x < w.x + w.w + pad && y > w.y - pad && y < w.y + w.h + pad) return false;
      }
    }
    return true;
  }

  // Oyuncuları birbirinden en uzak hücrelere yerleştir (önce köşeler)
  function spawnCells(seed, n) {
    const r = rng(seed ^ 0x9e3779b9);
    const corners = [[0, 0], [C - 1, R - 1], [C - 1, 0], [0, R - 1]];
    for (let i = corners.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [corners[i], corners[j]] = [corners[j], corners[i]];
    }
    const out = corners.slice(0, Math.min(n, 4));
    while (out.length < n) {
      let best = null, bd = -1;
      for (let rr = 0; rr < R; rr++) for (let c = 0; c < C; c++) {
        const d = Math.min(...out.map(([x, y]) => Math.hypot(x - c, y - rr)));
        if (d > bd) { bd = d; best = [c, rr]; }
      }
      out.push(best);
    }
    return out;
  }

  class TMatch {
    constructor(seed) {
      this.players = new Map(); // id -> tank
      this.bullets = [];
      this.mines = [];
      this.score = new Map(); // id -> kazanılan tur
      this.tick = 0;
      this.round = 0;
      this.nextId = 1;
      this.phase = 'ready'; // ready | play | over | ended
      this.timer = 0;
      this.seed = seed || 1;
      this.map = buildMap(this.seed);
    }

    addPlayer(id) {
      const t = {
        id, x: -100, y: -100, a: 0, alive: false, input: 0, fireReady: true, mineReady: true,
        plant: 0, minesLeft: T.mines,
      };
      this.players.set(id, t);
      if (!this.score.has(id)) this.score.set(id, 0);
      return t;
    }

    removePlayer(id) {
      this.players.delete(id);
      this.score.delete(id);
      this.mines = this.mines.filter((m) => m.owner !== id);
    }

    setInput(id, bits) {
      const t = this.players.get(id);
      if (t) t.input = bits & 255;
    }

    // Yeni tur: yeni labirent, herkes uzak köşelere
    newRound(seed) {
      this.round++;
      this.seed = seed;
      this.map = buildMap(seed);
      this.bullets = [];
      this.mines = [];
      this.phase = 'ready';
      this.timer = Math.round(T.readySeconds * TPS);
      const list = [...this.players.values()];
      const cells = spawnCells(seed, list.length);
      const r = rng(seed ^ 0x51ed);
      list.sort((a, b) => a.id - b.id);
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      list.forEach((t, i) => {
        const [c, rr] = cells[i];
        t.x = (c + 0.5) * CELL;
        t.y = (rr + 0.5) * CELL;
        // Açık bir yöne bak
        const o = this.map.open[rr * C + c];
        const a = [[E, 0], [S, Math.PI / 2], [Wd, Math.PI], [N, -Math.PI / 2]].filter(([b]) => o & b);
        t.a = a.length ? a[Math.floor(r() * a.length)][1] : 0;
        t.alive = true;
        t.plant = 0;
        t.minesLeft = T.mines;
        t.fireReady = t.mineReady = false; // tur başında basılı kalan tuş ateş etmesin
      });
    }

    aliveList() {
      return [...this.players.values()].filter((t) => t.alive);
    }

    kill(t, by, ev, how) {
      if (!t.alive) return;
      t.alive = false;
      t.plant = 0;
      ev.push({ type: 'kill', id: t.id, by, how, x: t.x, y: t.y });
    }

    step(predict) {
      const ev = [];
      this.tick++;
      if (this.phase === 'ended') return ev;
      if (this.phase === 'ready') {
        if (--this.timer <= 0) this.phase = 'play';
        for (const t of this.players.values()) {
          if (!(t.input & INPUT.FIRE)) t.fireReady = true;
          if (!(t.input & INPUT.MINE)) t.mineReady = true;
        }
        return ev;
      }
      const map = this.map;

      // 1) Tanklar
      for (const t of this.players.values()) {
        if (!t.alive) continue;
        const k = t.input;
        if (t.plant > 0) {
          // Mayın kuruluyor: tank kıpırdayamaz
          if (--t.plant === 0) {
            t.minesLeft--;
            this.mines.push({ id: this.nextId++, owner: t.id, x: t.x, y: t.y, armed: false });
            ev.push({ type: 'mine', id: t.id });
          }
        } else {
          const mud = inMud(map, t.x, t.y);
          const turn = ((k & INPUT.RIGHT) ? 1 : 0) - ((k & INPUT.LEFT) ? 1 : 0);
          t.a += turn * T.rot * (mud ? T.mudRot : 1);
          if (t.a > Math.PI) t.a -= Math.PI * 2;
          if (t.a < -Math.PI) t.a += Math.PI * 2;
          const mv = (k & INPUT.UP ? T.speed : 0) - (k & INPUT.DOWN ? T.backSpeed : 0);
          if (mv) {
            const sp = mv * (mud ? T.mud : 1);
            t.x += Math.cos(t.a) * sp;
            t.y += Math.sin(t.a) * sp;
          }
          for (let i = 0; i < 2; i++) for (const w of map.near[cellOf(t.x, t.y)]) pushOut(t, T.tankR, w);
          if (k & INPUT.MINE) {
            if (t.mineReady && t.minesLeft > 0 && this.phase === 'play') t.plant = Math.round(T.plantSeconds * TPS);
            t.mineReady = false;
          } else t.mineReady = true;
        }
        // Ateş: her basışta bir mermi, aynı anda en fazla 5
        if (k & INPUT.FIRE) {
          if (t.fireReady && this.bullets.filter((b) => b.owner === t.id).length < T.maxBullets) {
            const dx = Math.cos(t.a), dy = Math.sin(t.a);
            const b = { id: this.nextId++, owner: t.id, x: t.x + dx * (T.tankR + 5), y: t.y + dy * (T.tankR + 5), vx: dx * T.bulletSpeed, vy: dy * T.bulletSpeed, dist: 0 };
            // Namlu duvarın içindeyse mermi tankın önünden geri seker
            if (!lineClear(map, t.x, t.y, b.x, b.y, T.bulletR)) {
              b.x = t.x;
              b.y = t.y;
              b.vx = -b.vx;
              b.vy = -b.vy;
            }
            this.bullets.push(b);
            ev.push({ type: 'fire', id: t.id });
          }
          t.fireReady = false;
        } else t.fireReady = true;
      }
      // Tank-tank çarpışması
      const alive = this.aliveList();
      for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = T.tankR * 2;
        if (d > 0 && d < min) {
          const o = (min - d) / 2;
          a.x -= (dx / d) * o; a.y -= (dy / d) * o;
          b.x += (dx / d) * o; b.y += (dy / d) * o;
        }
      }

      // 2) Mermiler: duvardan seker, aldığı yol menzile ulaşınca yok olur
      const keep = [];
      for (const b of this.bullets) {
        let dead = false;
        for (let s = 0; s < SUB && !dead; s++) {
          b.x += b.vx / SUB;
          b.y += b.vy / SUB;
          b.dist += T.bulletSpeed / SUB;
          for (const w of map.near[cellOf(b.x, b.y)]) {
            const n = pushOut(b, T.bulletR, w);
            if (n) {
              const vn = b.vx * n.nx + b.vy * n.ny;
              if (vn < 0) {
                b.vx -= 2 * vn * n.nx;
                b.vy -= 2 * vn * n.ny;
                ev.push({ type: 'bounce', x: b.x, y: b.y });
              }
            }
          }
          for (const t of this.players.values()) {
            if (!t.alive || (t.id === b.owner && b.dist < T.grace)) continue;
            if (Math.hypot(t.x - b.x, t.y - b.y) < T.tankR + T.bulletR) {
              this.kill(t, b.owner, ev, 'bullet');
              dead = true;
              break;
            }
          }
        }
        if (!dead && b.dist < T.range) keep.push(b);
      }
      this.bullets = keep;

      // 3) Mayınlar: sahibi uzaklaşınca kurulur; üstünden geçen (sahibi dahil) patlatır
      const left = [];
      for (const m of this.mines) {
        const own = this.players.get(m.owner);
        if (!m.armed && (!own || !own.alive || Math.hypot(own.x - m.x, own.y - m.y) > T.tankR + T.mineR + 6)) m.armed = true;
        const hit = this.aliveList().some((t) => (t.id !== m.owner || m.armed) && Math.hypot(t.x - m.x, t.y - m.y) < T.tankR + T.mineR);
        if (!hit) {
          left.push(m);
          continue;
        }
        ev.push({ type: 'boom', x: m.x, y: m.y, owner: m.owner });
        for (const t of this.aliveList()) if (Math.hypot(t.x - m.x, t.y - m.y) < T.blast + T.tankR) this.kill(t, m.owner, ev, 'mine');
      }
      this.mines = left;

      // 4) Tur kuralları (sadece sunucu)
      if (predict) return ev;
      if (this.phase === 'play' && this.aliveList().length <= 1) {
        this.phase = 'over';
        this.timer = Math.round(T.overSeconds * TPS);
      } else if (this.phase === 'over' && --this.timer <= 0) {
        // Bekleme bitti: hâlâ ayakta kalan tek tank turu kazanır (son anda kendi mermisiyle ölebilir)
        const win = this.aliveList();
        const winner = win.length === 1 ? win[0].id : null;
        if (winner != null) this.score.set(winner, (this.score.get(winner) || 0) + 1);
        ev.push({ type: 'round', winner, round: this.round });
        this.newRound((Math.random() * 0x7fffffff) | 0 || 7);
      }
      return ev;
    }

    finish(ev, reason) {
      this.phase = 'ended';
      ev.push({ type: 'end', reason, standings: this.standings() });
    }

    standings() {
      return [...this.score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, s }));
    }

    snapshot(acks) {
      const r = (v) => Math.round(v * 1000) / 1000;
      const t = [];
      for (const q of this.players.values()) {
        const [ack, buf] = acks ? acks(q.id) : [0, 2];
        t.push([q.id, r(q.x), r(q.y), r(q.a), q.input, q.alive ? 1 : 0, (q.fireReady ? 1 : 0) | (q.mineReady ? 2 : 0), q.plant, q.minesLeft, ack, buf]);
      }
      return {
        n: this.tick, ph: this.phase, tmr: this.timer, rd: this.round, seed: this.seed, nid: this.nextId,
        sc: [...this.score.entries()], tk: t, // 't' mesaj türü için ayrılmış
        b: this.bullets.map((b) => [b.id, b.owner, r(b.x), r(b.y), r(b.vx), r(b.vy), r(b.dist)]),
      };
    }

    // Sahibine özel: sadece kendi mayınları (başkalarınınki görünmez)
    minesOf(id) {
      return this.mines.filter((m) => m.owner === id).map((m) => [m.id, m.x, m.y, m.armed ? 1 : 0]);
    }

    load(g, myId) {
      const seen = new Set();
      for (const [id, x, y, a, input, alive, rd, plant, ml] of g.tk) {
        seen.add(id);
        const q = this.players.get(id) || this.addPlayer(id);
        q.x = x; q.y = y; q.a = a; q.input = input; q.alive = !!alive;
        q.fireReady = !!(rd & 1); q.mineReady = !!(rd & 2); q.plant = plant; q.minesLeft = ml;
      }
      for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
      this.bullets = g.b.map(([id, owner, x, y, vx, vy, dist]) => ({ id, owner, x, y, vx, vy, dist }));
      this.mines = (g.mn || []).map(([id, x, y, armed]) => ({ id, owner: myId, x, y, armed: !!armed }));
      this.tick = g.n;
      this.phase = g.ph;
      this.timer = g.tmr;
      this.round = g.rd;
      this.nextId = g.nid;
      if (g.seed !== this.seed) {
        this.seed = g.seed;
        this.map = buildMap(g.seed);
      }
      this.score = new Map(g.sc);
    }
  }

  return { TMatch, INPUT, TPS, buildMap, cellOf, inMud, lineClear, rng };
});
