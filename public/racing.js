// F1 yarış motoru (üstten görünüm, Ultimate Racing 2D tarzı arcade fizik).
// Sunucu (otoriter) ve tarayıcı (tahmin) aynı kodu çalıştırır. Birimler: piksel, tick (60/sn).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./track.js'));
  else root.RACING = factory(root.TRACK);
})(typeof self !== 'undefined' ? self : this, function (TRACK) {
  'use strict';
  const TPS = 60;
  const INPUT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8 };

  // Araç ve fizik ayarları
  const CAR = {
    length: 26, width: 11,
    accel: 0.034, // düşük hızda motor ivmesi (px/tick²): 0-100 km/h ≈ 1.2 sn
    drag: 0.034 / (7.4 * 7.4), // hava direnci: son hız ≈ 7.4 px/tick (≈444 px/sn, ekranda 320 km/h)
    rolling: 0.0006, // yuvarlanma direnci (hızla orantılı)
    engineBrake: 0.012, // gaz bırakılınca
    brake: 0.062, // 320 km/h'den durma ≈ 1.8 sn
    reverseMax: 1.6,
    turnRate: 0.037, // düşük-orta hızda en fazla dönüş (rad/tick)
    turnHighSpeedLoss: 0.42, // son hızda dönüş kabiliyeti bu oranda azalır
    steerResponse: 0.12, // direksiyonun hedef açıya yaklaşma hızı (düşük = daha yumuşak)
  };
  // Yüzeyler: yan yol tutuşu (yanal hızdan her tick silinebilecek miktar), motor ve direnç çarpanları
  // Virajı savrulmadan alabileceğin en yüksek hız ≈ √(grip × yarıçap)
  const SURFACE = {
    road: { grip: 0.2, engine: 1, drag: 1, rolling: 0.25 },
    kerb: { grip: 0.17, engine: 1, drag: 1.1, rolling: 0.6 },
    grass: { grip: 0.075, engine: 0.55, drag: 2.6, rolling: 3 },
    wall: { grip: 0.075, engine: 0.55, drag: 2.6, rolling: 3 },
    out: { grip: 0.075, engine: 0.55, drag: 2.6, rolling: 3 },
  };
  // Rüzgar arkası: öndeki aracın arkasında, bu mesafe ve yanal hizada hava direnci azalır
  const SLIP = { near: 30, far: 240, lateral: 16, dragCut: 0.12 }; // son hız ≈ +%6
  const VMAX = Math.sqrt(CAR.accel / CAR.drag);
  const LAPS = 2;
  const MAX_CARS = 12;
  const CAR_R = CAR.width / 2 + 0.5; // çarpışma için 2 daire (ön/arka)
  const CAR_OFF = CAR.length / 2 - CAR_R;
  const LIGHTS_TICKS = 5 * TPS; // 5 kırmızı ışık, saniyede bir yanar
  const FINISH_WAIT = 25 * TPS; // birinci bitirince diğerlerine kalan süre
  const L = TRACK.LENGTH;
  const SEC_LEN = L / TRACK.SECTORS;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  class Race {
    constructor() {
      this.cars = new Map(); // id -> araç
      this.tick = 0;
      this.phase = 'grid'; // grid | lights | race | finish | ended
      this.timer = TPS * 2; // grid bekleme
      this.goTick = 0; // yarışın başladığı tick
      this.lightsOut = 0; // ışıkların sönme anı (rastgele gecikme)
      this.finishOrder = [];
      this.firstFinishTick = 0;
      this.seed = 1;
    }

    addCar(id, color, slot) {
      const g = TRACK.gridSlot(slot);
      const c = {
        id, color, slot,
        x: g.x, y: g.y, a: g.a, vx: 0, vy: 0, steer: 0,
        input: 0, hint: g.i, surface: 'road',
        lap: 0, sec: TRACK.SECTORS - 1, s: TRACK.S[g.i],
        lapStart: 0, lastLap: 0, bestLap: 0, finished: 0, slip: 0,
      };
      this.cars.set(id, c);
      return c;
    }

    removeCar(id) {
      this.cars.delete(id);
    }

    setInput(id, bits) {
      const c = this.cars.get(id);
      if (c) c.input = bits & 15;
    }

    rand() {
      this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
      return this.seed / 4294967296;
    }

    progress(c) {
      // Sıralama için toplam ilerleme: tamamlanan turlar + çizgiden itibaren mesafe
      return (c.lap - 1) * L + c.s;
    }

    step(predict) {
      const events = [];
      this.tick++;
      if (this.phase === 'ended') return events;

      if (this.phase === 'grid' || this.phase === 'lights') {
        // Araçlar yerinde bekler
        if (--this.timer <= 0) {
          if (this.phase === 'grid') {
            this.phase = 'lights';
            this.timer = LIGHTS_TICKS + Math.floor(12 + this.rand() * 60); // 5 ışık + rastgele sönme gecikmesi
            if (!predict) events.push({ type: 'lights' });
          } else {
            this.phase = 'race';
            this.goTick = this.tick;
            for (const c of this.cars.values()) c.lapStart = this.tick;
            if (!predict) events.push({ type: 'go' });
          }
        }
        return events;
      }

      const list = [...this.cars.values()];
      // 1) Rüzgar arkası: her araç için arkasında olduğu en yakın aracı bul
      for (const c of list) {
        c.slip = 0;
        const fx = Math.cos(c.a), fy = Math.sin(c.a);
        for (const o of list) {
          if (o === c || o.finished) continue;
          const dx = o.x - c.x, dy = o.y - c.y;
          const along = dx * fx + dy * fy; // öndeki araç önümde mi
          if (along < SLIP.near || along > SLIP.far) continue;
          const side = Math.abs(-dx * fy + dy * fx);
          if (side > SLIP.lateral) continue;
          // Aynı yöne gidiyor olmalı
          if (Math.cos(o.a - c.a) < 0.8) continue;
          const k = 1 - (along - SLIP.near) / (SLIP.far - SLIP.near);
          c.slip = Math.max(c.slip, 0.35 + 0.65 * k);
        }
      }

      // 2) Sürüş
      for (const c of list) this.drive(c);

      // 3) Araç-araç çarpışmaları (her araç 2 daire)
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) collideCars(list[i], list[j]);
      }

      // 4) Pist, tur ve kurallar
      for (const c of list) {
        const sf = TRACK.surfaceAt(c.x, c.y, c.hint);
        if (sf.p) {
          c.hint = sf.p.i;
          this.walls(c, sf.p);
          c.surface = sf.kind === 'wall' ? 'grass' : sf.kind;
          this.laps(c, sf.p.s, events, predict);
        } else {
          c.surface = 'out';
        }
      }

      if (!predict) {
        if (this.phase === 'finish') {
          const allDone = list.every((c) => c.finished);
          if (allDone || this.tick - this.firstFinishTick >= FINISH_WAIT) this.finish(events, allDone ? 'done' : 'time');
        }
        if (!list.length && this.phase !== 'ended') this.finish(events, 'empty');
      }
      return events;
    }

    drive(c) {
      const racing = this.phase === 'race' || this.phase === 'finish';
      const inp = racing && !c.finished ? c.input : c.finished ? INPUT.DOWN : 0; // bitiren yavaşça durur
      const sf = SURFACE[c.surface] || SURFACE.road;

      // Direksiyon: hedef açıya yumuşak yaklaşır. Dönüş kabiliyeti hızla artar, çok yüksek hızda azalır
      const target = (inp & INPUT.LEFT ? -1 : 0) + (inp & INPUT.RIGHT ? 1 : 0);
      c.steer += (target - c.steer) * CAR.steerResponse;
      let fx = Math.cos(c.a), fy = Math.sin(c.a);
      const vf0 = c.vx * fx + c.vy * fy;
      const sp = Math.abs(vf0);
      const turn = CAR.turnRate * Math.min(1, sp / 1.8) * (1 - CAR.turnHighSpeedLoss * Math.min(1, sp / VMAX));
      c.a += c.steer * turn * (vf0 >= 0 ? 1 : -1);

      // Hızı aracın YENİ yönüne göre ayır: dönüşün yarattığı yanal hız tutuşla sönümlenir
      fx = Math.cos(c.a);
      fy = Math.sin(c.a);
      let vf = c.vx * fx + c.vy * fy;
      let vl = -c.vx * fy + c.vy * fx;

      // Boyuna: motor, fren/geri, motor freni, hava ve yuvarlanma direnci (rüzgar arkasında hava direnci azalır)
      if (inp & INPUT.UP) vf += CAR.accel * sf.engine;
      if (inp & INPUT.DOWN) {
        if (vf > 0.05) vf = Math.max(0, vf - CAR.brake);
        else vf = Math.max(-CAR.reverseMax, vf - CAR.accel * 0.5);
      } else if (!(inp & INPUT.UP)) {
        vf -= Math.sign(vf) * Math.min(Math.abs(vf), CAR.engineBrake);
      }
      const drag = CAR.drag * sf.drag * (1 - SLIP.dragCut * c.slip);
      vf -= drag * vf * Math.abs(vf) + CAR.rolling * sf.rolling * vf;

      // Yanal tutuş: her tick en fazla 'grip' kadar. Viraj isteği tutuşu aşarsa araç dışa kayar (understeer)
      vl -= Math.sign(vl) * Math.min(Math.abs(vl), sf.grip);

      c.vx = vf * fx - vl * fy;
      c.vy = vf * fy + vl * fx;
      c.x += c.vx;
      c.y += c.vy;
    }

    // Lastik bariyerleri: kaçış alanının sonunda sert duvar
    walls(c, p) {
      const lim = TRACK.HALF + TRACK.RUNOFF - CAR_R;
      if (p.dist <= lim) return;
      const i = p.i;
      const side = p.lat >= 0 ? 1 : -1;
      // Sol normal (ty, -tx)
      const nx = TRACK.TY[i] * side, ny = -TRACK.TX[i] * side;
      const over = p.dist - lim;
      c.x -= nx * over;
      c.y -= ny * over;
      const vn = c.vx * nx + c.vy * ny;
      if (vn > 0) {
        c.vx -= nx * vn * 1.35; // %35 geri sekme
        c.vy -= ny * vn * 1.35;
        c.vx *= 0.7;
        c.vy *= 0.7;
      }
    }

    laps(c, s, events, predict) {
      c.s = s;
      const sec = Math.floor(s / SEC_LEN) % TRACK.SECTORS;
      if (sec === c.sec) return;
      // Sadece sıradaki sektöre geçiş sayılır (kısa yol kesme ve ters yön sayılmaz)
      if (sec !== (c.sec + 1) % TRACK.SECTORS) return;
      c.sec = sec;
      if (sec !== 0 || this.phase === 'grid' || this.phase === 'lights') return;
      // Bitiş çizgisi geçildi
      if (c.lap > 0) {
        const t = this.tick - c.lapStart;
        c.lastLap = t;
        if (!c.bestLap || t < c.bestLap) c.bestLap = t;
        if (!predict) events.push({ type: 'lap', id: c.id, lap: c.lap, time: t });
      }
      c.lapStart = this.tick;
      c.lap++;
      if (c.lap > LAPS && !c.finished) {
        c.finished = this.tick;
        if (predict) return;
        this.finishOrder.push(c.id);
        if (this.phase === 'race') {
          this.phase = 'finish';
          this.firstFinishTick = this.tick;
        }
        events.push({ type: 'finish', id: c.id, pos: this.finishOrder.length, time: this.tick - this.goTick });
      }
    }

    finish(events, reason) {
      this.phase = 'ended';
      events.push({ type: 'end', reason, results: this.standings() });
    }

    // Sıralama: bitirenler bitiş sırasıyla, sonra ilerlemeye göre
    standings() {
      const list = [...this.cars.values()];
      list.sort((a, b) => {
        if (a.finished && b.finished) return a.finished - b.finished;
        if (a.finished) return -1;
        if (b.finished) return 1;
        return this.progress(b) - this.progress(a);
      });
      return list.map((c) => ({
        id: c.id, lap: Math.min(c.lap, LAPS), finished: c.finished ? c.finished - this.goTick : 0, best: c.bestLap,
      }));
    }

    snapshot(acks) {
      const r = (v) => Math.round(v * 1000) / 1000;
      const p = [];
      for (const c of this.cars.values()) {
        const [ack, buf] = acks ? acks(c.id) : [0, 2];
        p.push([c.id, r(c.x), r(c.y), r(c.a), r(c.vx), r(c.vy), r(c.steer), c.input, c.hint, c.lap, c.sec,
          c.lapStart, c.lastLap, c.bestLap, c.finished, ack, buf, c.slot]);
      }
      return { n: this.tick, ph: this.phase, tmr: this.timer, go: this.goTick, p };
    }

    load(g) {
      const seen = new Set();
      for (const q of g.p) {
        const [id, x, y, a, vx, vy, steer, input, hint, lap, sec, lapStart, lastLap, bestLap, finished, , , slot] = q;
        seen.add(id);
        let c = this.cars.get(id);
        if (!c) c = this.addCar(id, '#fff', slot);
        Object.assign(c, { x, y, a, vx, vy, steer, input, hint, lap, sec, lapStart, lastLap, bestLap, finished, slot });
      }
      for (const id of [...this.cars.keys()]) if (!seen.has(id)) this.cars.delete(id);
      this.tick = g.n;
      this.phase = g.ph;
      this.timer = g.tmr;
      this.goTick = g.go;
    }
  }

  function collideCars(a, b) {
    // Her aracı ön ve arka daire olarak düşün
    const circles = (c) => {
      const fx = Math.cos(c.a) * CAR_OFF, fy = Math.sin(c.a) * CAR_OFF;
      return [[c.x + fx, c.y + fy], [c.x - fx, c.y - fy]];
    };
    const ca = circles(a), cb = circles(b);
    for (const p of ca) for (const q of cb) {
      const dx = p[0] - q[0], dy = p[1] - q[1];
      const d2 = dx * dx + dy * dy, rs = CAR_R * 2;
      if (d2 >= rs * rs || d2 === 0) continue;
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, over = rs - d;
      a.x += nx * over * 0.5; a.y += ny * over * 0.5;
      b.x -= nx * over * 0.5; b.y -= ny * over * 0.5;
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (rel < 0) {
        const imp = rel * (1 + 0.3) * 0.5;
        a.vx -= nx * imp; a.vy -= ny * imp;
        b.vx += nx * imp; b.vy += ny * imp;
      }
    }
  }

  // Ekranda gösterilecek hız (km/h): son hız 320 km/h görünür
  function kmh(c) {
    return Math.round(Math.hypot(c.vx, c.vy) / Math.sqrt(CAR.accel / CAR.drag) * 320);
  }

  return { Race, INPUT, TPS, CAR, LAPS, MAX_CARS, kmh, SLIP };
});
