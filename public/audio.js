// Ses motoru: tüm efektler Web Audio ile anında üretilir (dosya yok).
// window.SFX — tek seferlik efektler, sürekli döngüler (su, çamur, buz, lastik) ve V8 motor sesi.
(function () {
  'use strict';
  const KEY = 'imlec-kampi:ses';
  let ac = null, master = null, bus = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem(KEY) === 'kapali'; } catch {}
  const loops = {};

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const now = () => ac.currentTime;
  const ready = () => ac && ac.state === 'running';

  function init() {
    if (ac) { if (ac.state === 'suspended' && !document.hidden) ac.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master = ac.createGain();
    master.gain.value = muted ? 0 : 0.8;
    master.connect(comp);
    comp.connect(ac.destination);
    bus = master;
    // 2 sn beyaz gürültü (tüm hışırtı/su/lastik sesleri bundan süzülür)
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ac.suspend().catch(() => {});
      else ac.resume().catch(() => {});
    });
  }

  function setMuted(v) {
    muted = v;
    try { localStorage.setItem(KEY, v ? 'kapali' : 'acik'); } catch {}
    if (master) master.gain.setTargetAtTime(v ? 0 : 0.8, now(), 0.05);
  }

  // Çıkış: isteğe bağlı stereo konum
  function out(pan) {
    if (pan && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      p.connect(bus);
      return p;
    }
    return bus;
  }

  function noiseSrc(loop) {
    const s = ac.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    if (!loop) s.loopStart = 0;
    s.start(now(), Math.random() * 1.5);
    return s;
  }

  // Kısa ton: frekans kaydırmalı, üstel sönümlü
  function tone(o) {
    if (!ready()) return;
    const t = now() + (o.delay || 0);
    const osc = ac.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide || o.dur));
    const g = ac.createGain();
    const a = o.attack || 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol), t + a);
    if (o.hold) g.gain.setValueAtTime(o.vol, t + a + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g);
    g.connect(out(o.pan));
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
    return osc;
  }

  // Süzülmüş gürültü patlaması
  function burst(o) {
    if (!ready()) return;
    const t = now() + (o.delay || 0);
    const s = ac.createBufferSource();
    s.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.f, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
    f.Q.value = o.q || 1;
    const g = ac.createGain();
    const a = o.attack || 0.003;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    s.connect(f);
    f.connect(g);
    g.connect(out(o.pan));
    s.start(t, Math.random() * 1.5);
    s.stop(t + o.dur + 0.05);
  }

  // Sürekli döngü: gürültü -> filtre (LFO ile oynar) -> kazanç. set(seviye) ile yumuşakça açılır/kısılır
  function makeLoop(o) {
    const s = noiseSrc(true);
    const f = ac.createBiquadFilter();
    f.type = o.filter;
    f.frequency.value = o.f;
    f.Q.value = o.q || 1;
    const g = ac.createGain();
    g.gain.value = 0;
    s.connect(f);
    f.connect(g);
    let pan = null;
    if (ac.createStereoPanner) {
      pan = ac.createStereoPanner();
      g.connect(pan);
      pan.connect(bus);
    } else g.connect(bus);
    if (o.lfo) {
      const l = ac.createOscillator();
      l.frequency.value = o.lfo;
      const lg = ac.createGain();
      lg.gain.value = o.lfoDepth;
      l.connect(lg);
      lg.connect(f.frequency);
      l.start();
    }
    if (o.am) {
      // Genlik titreşimi (kerb "brrr", çamur şapırtısı)
      const am = ac.createGain();
      am.gain.value = 1 - o.amDepth;
      const l = ac.createOscillator();
      l.frequency.value = o.am;
      const lg = ac.createGain();
      lg.gain.value = o.amDepth;
      l.connect(lg);
      lg.connect(am.gain);
      l.start();
      f.disconnect();
      f.connect(am);
      am.connect(g);
    }
    let cur = 0;
    return {
      set(level, opts) {
        if (!ac) return;
        const v = clamp(level, 0, 1) * o.max;
        if (Math.abs(v - cur) > 0.001) {
          g.gain.setTargetAtTime(v, now(), o.smooth || 0.08);
          cur = v;
        }
        if (opts && opts.freq) f.frequency.setTargetAtTime(opts.freq, now(), 0.05);
        if (opts && pan && opts.pan != null) pan.pan.setTargetAtTime(clamp(opts.pan, -1, 1), now(), 0.05);
      },
    };
  }

  function loop(name) {
    if (!ac) return { set() {} };
    if (!loops[name]) loops[name] = makeLoop(LOOPS[name]);
    return loops[name];
  }

  const LOOPS = {
    water: { filter: 'bandpass', f: 750, q: 0.9, lfo: 2.3, lfoDepth: 320, max: 0.22 }, // yüzme şıpırtısı
    mud: { filter: 'lowpass', f: 320, q: 4, am: 4.5, amDepth: 0.7, max: 0.3, lfo: 1.3, lfoDepth: 120 },
    ice: { filter: 'highpass', f: 4200, q: 0.7, max: 0.07, smooth: 0.12 }, // buzda kayma
    river: { filter: 'bandpass', f: 1100, q: 0.5, lfo: 0.35, lfoDepth: 400, max: 0.08, smooth: 0.4 }, // uzaktan akıntı
    screech: { filter: 'bandpass', f: 2600, q: 9, lfo: 13, lfoDepth: 260, max: 0.18, smooth: 0.04 }, // lastik
    gravel: { filter: 'lowpass', f: 900, q: 0.8, am: 22, amDepth: 0.5, max: 0.25, smooth: 0.05 }, // çim/kum
    kerb: { filter: 'lowpass', f: 420, q: 2, am: 38, amDepth: 0.9, max: 0.3, smooth: 0.03 }, // kerb titreşimi
    crowd: { filter: 'bandpass', f: 900, q: 0.6, lfo: 0.25, lfoDepth: 250, max: 0.07, smooth: 0.5 }, // tribün uğultusu
  };

  // ---------- V8 motor ----------
  // 8 silindir, 4 zamanlı: ateşleme frekansı = devir/60 × 4. Düzensiz ateşlemenin "lop lop" sesi için
  // yarım ve çeyrek frekansta ek osilatörler + genlik titreşimi; bozulma ve devirle açılan filtre.
  const GEARS = [72, 112, 152, 192, 232, 272, 340]; // vitesin son hızı (km/h)
  const IDLE = 950, REDLINE = 7800;
  const shaperCurve = (() => {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 2.6); }
    return c;
  })();

  class Engine {
    constructor() {
      const t = now();
      this.a = ac.createOscillator(); this.a.type = 'sawtooth';
      this.b = ac.createOscillator(); this.b.type = 'sawtooth';
      this.c = ac.createOscillator(); this.c.type = 'square';
      this.lfo = ac.createOscillator(); this.lfo.type = 'sine';
      const ga = ac.createGain(); ga.gain.value = 0.42;
      const gb = ac.createGain(); gb.gain.value = 0.36;
      const gc = ac.createGain(); gc.gain.value = 0.2;
      this.a.detune.value = 4;
      this.b.detune.value = -7;
      const mix = ac.createGain();
      this.a.connect(ga); this.b.connect(gb); this.c.connect(gc);
      ga.connect(mix); gb.connect(mix); gc.connect(mix);
      // Egzoz hışırtısı
      this.noise = noiseSrc(true);
      this.nf = ac.createBiquadFilter(); this.nf.type = 'bandpass'; this.nf.Q.value = 1.2;
      this.ng = ac.createGain(); this.ng.gain.value = 0;
      this.noise.connect(this.nf); this.nf.connect(this.ng); this.ng.connect(mix);
      this.shape = ac.createWaveShaper(); this.shape.curve = shaperCurve; this.shape.oversample = '2x';
      this.drive = ac.createGain(); this.drive.gain.value = 0.9;
      this.lp = ac.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.Q.value = 2.2;
      this.body = ac.createBiquadFilter(); this.body.type = 'peaking'; this.body.frequency.value = 120; this.body.gain.value = 7; this.body.Q.value = 0.9;
      this.lope = ac.createGain(); this.lope.gain.value = 0.75;
      const lg = ac.createGain(); lg.gain.value = 0.25;
      this.lfo.connect(lg); lg.connect(this.lope.gain);
      this.vol = ac.createGain(); this.vol.gain.value = 0;
      this.pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
      mix.connect(this.drive); this.drive.connect(this.shape); this.shape.connect(this.lp);
      this.lp.connect(this.body); this.body.connect(this.lope); this.lope.connect(this.vol);
      if (this.pan) { this.vol.connect(this.pan); this.pan.connect(bus); } else this.vol.connect(bus);
      for (const o of [this.a, this.b, this.c, this.lfo]) o.start(t);
      this.rpm = IDLE;
      this.gear = 0;
      this.cut = 0; // vites geçişinde kısa gaz kesme
      this.popAt = 0;
      this.dead = false;
    }

    // kmh: hız, thr: gaz (0/1), gain: mesafe sesi (0-1), pan: -1..1
    update(kmh, thr, gain, pan, dt) {
      if (this.dead) return;
      const t = now();
      // Vites kutusu (histerezisli)
      let g = this.gear;
      const top = (i) => GEARS[i];
      if (kmh > top(g) * 0.985 && g < GEARS.length - 1) g++;
      while (g > 0 && kmh < top(g - 1) * 0.7) g--;
      let target;
      if (kmh < 4) {
        g = 0;
        target = IDLE + (thr ? 3600 : 0); // gridde gaz: boşta devir çevirme
      } else {
        const lo = g ? top(g - 1) * 0.62 : 0;
        const r = clamp((kmh - lo) / (top(g) - lo), 0, 1);
        target = Math.max(IDLE + 250, 2600 + r * (REDLINE - 2600) - (g === 0 ? 1200 * (1 - r) : 0));
      }
      if (g > this.gear && kmh >= 4) {
        this.cut = 0.09; // yukarı vites: kısa kesinti + patlama
        if (gain > 0.15) this.pop(gain * 0.6, pan);
      }
      this.gear = g;
      const k = 1 - Math.exp(-dt * (target > this.rpm ? 9 : 6));
      this.rpm += (target - this.rpm) * k;
      if (this.rpm > REDLINE) this.rpm = REDLINE - 150 * Math.random(); // limitör
      const f = (this.rpm / 60) * 4;
      const load = thr ? 1 : 0.35;
      this.cut = Math.max(0, this.cut - dt);
      const cutK = this.cut > 0 ? 0.25 : 1;
      const tc = 0.025;
      this.a.frequency.setTargetAtTime(f, t, tc);
      this.b.frequency.setTargetAtTime(f / 2, t, tc);
      this.c.frequency.setTargetAtTime(f / 4, t, tc);
      this.lfo.frequency.setTargetAtTime(f / 8, t, tc);
      this.nf.frequency.setTargetAtTime(f * 3, t, tc);
      this.ng.gain.setTargetAtTime(0.08 + 0.2 * load, t, 0.05);
      this.drive.gain.setTargetAtTime(0.6 + 1.1 * load, t, 0.05);
      this.lp.frequency.setTargetAtTime(220 + this.rpm * 0.16 + load * 900, t, 0.04);
      const base = 0.13 + 0.13 * load + 0.06 * (this.rpm / REDLINE);
      this.vol.gain.setTargetAtTime(base * gain * cutK, t, this.cut > 0 ? 0.01 : 0.04);
      if (this.pan) this.pan.pan.setTargetAtTime(clamp(pan || 0, -1, 1), t, 0.05);
      // Gaz bırakınca yüksek devirde egzoz patlamaları
      if (!thr && this.rpm > 4200 && gain > 0.15 && t > this.popAt) {
        this.popAt = t + 0.09 + Math.random() * 0.25;
        if (Math.random() < 0.55) this.pop(gain * (0.4 + Math.random() * 0.4), pan);
      }
    }

    pop(v, pan) {
      burst({ filter: 'lowpass', f: 1400 + Math.random() * 900, f2: 300, q: 1, dur: 0.07, vol: 0.35 * v, pan });
      tone({ f: 90 + Math.random() * 40, f2: 45, dur: 0.08, vol: 0.25 * v, pan, type: 'triangle' });
    }

    stop() {
      if (this.dead) return;
      this.dead = true;
      const t = now();
      this.vol.gain.setTargetAtTime(0, t, 0.08);
      for (const o of [this.a, this.b, this.c, this.lfo, this.noise]) try { o.stop(t + 0.5); } catch {}
      setTimeout(() => { try { (this.pan || this.vol).disconnect(); } catch {} }, 700);
    }
  }

  // ---------- Tek seferlik efektler ----------
  const FX = {
    // Suya giriş: köpüklü şapırtı + "blup"
    splash(v, pan) {
      v = clamp(v, 0.2, 1);
      burst({ filter: 'lowpass', f: 4200, f2: 400, q: 0.8, dur: 0.45, vol: 0.4 * v, pan, attack: 0.01 });
      burst({ filter: 'bandpass', f: 1800, f2: 700, q: 2, dur: 0.25, vol: 0.25 * v, pan, delay: 0.03 });
      tone({ f: 520, f2: 140, dur: 0.18, vol: 0.18 * v, pan, delay: 0.02 });
      for (let i = 0; i < 3; i++) {
        tone({ f: 700 + Math.random() * 900, f2: 1600 + Math.random() * 800, dur: 0.05, vol: 0.05 * v, pan, delay: 0.12 + i * 0.07 + Math.random() * 0.05 });
      }
    },
    // Sudan çıkış: damlalar
    drip(pan) {
      for (let i = 0; i < 3; i++) {
        tone({ f: 900 + Math.random() * 700, f2: 1800 + Math.random() * 600, dur: 0.06, vol: 0.06, pan, delay: i * 0.09 + Math.random() * 0.04 });
      }
    },
    squelch(v, pan) {
      v = clamp(v, 0.3, 1);
      burst({ filter: 'lowpass', f: 700, f2: 180, q: 5, dur: 0.3, vol: 0.4 * v, pan, attack: 0.02 });
      tone({ f: 190, f2: 70, dur: 0.22, vol: 0.2 * v, pan, type: 'triangle' });
    },
    iceTick(pan) {
      tone({ f: 3200, f2: 2400, dur: 0.05, vol: 0.05, pan });
      tone({ f: 4700, dur: 0.04, vol: 0.03, pan, delay: 0.03 });
    },
    // Top vuruşu: tok "güm" + çıt
    kick(v, pan) {
      v = clamp(v, 0, 1);
      if (v < 0.03) return;
      tone({ f: 170, f2: 48, dur: 0.16, vol: 0.55 * v, pan, glide: 0.1 });
      burst({ filter: 'highpass', f: 2200, q: 0.7, dur: 0.035, vol: 0.3 * v, pan });
      burst({ filter: 'bandpass', f: 600, q: 1.5, dur: 0.07, vol: 0.2 * v, pan });
    },
    touch(v, pan) {
      v = clamp(v, 0, 1);
      if (v < 0.03) return;
      tone({ f: 140, f2: 60, dur: 0.1, vol: 0.28 * v, pan });
      burst({ filter: 'bandpass', f: 900, q: 1.2, dur: 0.04, vol: 0.1 * v, pan });
    },
    bounce(v, pan) {
      v = clamp(v, 0, 1);
      if (v < 0.03) return;
      tone({ f: 110, f2: 55, dur: 0.1, vol: 0.2 * v, pan });
      burst({ filter: 'lowpass', f: 1200, q: 0.8, dur: 0.05, vol: 0.08 * v, pan });
    },
    // Direk: metalik çınlama
    post(v, pan) {
      v = clamp(v, 0, 1);
      if (v < 0.03) return;
      for (const [f, a, d] of [[523, 0.2, 0.6], [1247, 0.12, 0.45], [1893, 0.08, 0.35], [2711, 0.05, 0.25]]) {
        tone({ f, dur: d, vol: a * v, pan, type: 'sine' });
      }
      burst({ filter: 'highpass', f: 3000, q: 0.7, dur: 0.03, vol: 0.2 * v, pan });
    },
    net(v, pan) {
      v = clamp(v, 0, 1);
      burst({ filter: 'bandpass', f: 1600, f2: 900, q: 0.9, dur: 0.4, vol: 0.22 * v, pan, attack: 0.02 });
    },
    // Gol: tribün coşkusu (yükselip azalan uğultu) + korna
    goal() {
      if (!ready()) return;
      const t = now();
      for (const [f, q, v] of [[500, 0.8, 0.35], [1100, 0.7, 0.3], [2300, 1, 0.12]]) {
        const s = noiseSrc(true);
        const fl = ac.createBiquadFilter();
        fl.type = 'bandpass'; fl.frequency.value = f; fl.Q.value = q;
        const am = ac.createGain();
        const l = ac.createOscillator(); l.frequency.value = 5 + Math.random() * 4;
        const lg = ac.createGain(); lg.gain.value = 0.25;
        am.gain.value = 0.75;
        l.connect(lg); lg.connect(am.gain);
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(v, t + 0.35);
        g.gain.setValueAtTime(v, t + 1.3);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3.4);
        s.connect(fl); fl.connect(am); am.connect(g); g.connect(bus);
        l.start(t); l.stop(t + 3.5); s.stop(t + 3.5);
      }
      for (const [f, d] of [[392, 0], [392, 0.22], [523, 0.44]]) {
        tone({ f, dur: 0.2, vol: 0.12, type: 'sawtooth', delay: 0.15 + d, hold: 0.12 });
        tone({ f: f * 1.005, dur: 0.2, vol: 0.08, type: 'square', delay: 0.15 + d, hold: 0.12 });
      }
    },
    // Hakem düdüğü: start (tek), half (iki), end (üç, sonuncusu uzun)
    whistle(kind) {
      if (!ready()) return;
      const seq = kind === 'end' ? [[0, 0.22], [0.32, 0.22], [0.64, 0.85]] : kind === 'half' ? [[0, 0.3], [0.42, 0.7]] : [[0, 0.55]];
      for (const [d, len] of seq) {
        const t = now() + d;
        const o = ac.createOscillator();
        o.type = 'sine';
        o.frequency.value = 2750;
        const v = ac.createOscillator();
        v.frequency.value = 38; // düdük bilyesinin titremesi
        const vg = ac.createGain(); vg.gain.value = 90;
        v.connect(vg); vg.connect(o.frequency);
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
        g.gain.setValueAtTime(0.16, t + len - 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g); g.connect(bus);
        o.start(t); v.start(t); o.stop(t + len + 0.05); v.stop(t + len + 0.05);
        burst({ filter: 'bandpass', f: 3000, q: 2, dur: len, vol: 0.04, delay: d, attack: 0.02 });
      }
    },
    // Geri sayım bipleri
    beep() { tone({ f: 660, dur: 0.22, vol: 0.2, type: 'square', hold: 0.1 }); },
    go() {
      tone({ f: 1320, dur: 0.7, vol: 0.2, type: 'square', hold: 0.45 });
      tone({ f: 660, dur: 0.7, vol: 0.08, type: 'square', hold: 0.45 });
    },
    lap() {
      tone({ f: 880, dur: 0.18, vol: 0.14, hold: 0.06 });
      tone({ f: 1320, dur: 0.3, vol: 0.14, delay: 0.12, hold: 0.1 });
    },
    finish() {
      [523, 659, 784, 1047].forEach((f, i) => tone({ f, dur: i === 3 ? 0.7 : 0.18, vol: 0.14, type: 'triangle', delay: i * 0.13, hold: i === 3 ? 0.35 : 0.05 }));
    },
    crash(v, pan) {
      v = clamp(v, 0, 1);
      if (v < 0.05) return;
      burst({ filter: 'lowpass', f: 1600, f2: 250, q: 0.8, dur: 0.3, vol: 0.45 * v, pan });
      tone({ f: 95, f2: 38, dur: 0.22, vol: 0.4 * v, pan, type: 'triangle' });
      burst({ filter: 'highpass', f: 3500, q: 1, dur: 0.08, vol: 0.12 * v, pan, delay: 0.02 });
    },
    // Voleybol: el ile topa "pat", smaç şaklaması, kuma düşüş, fileye takılma
    bump(v, pan) {
      v = Math.min(1, v);
      burst({ filter: 'bandpass', f: 1300, q: 1.4, dur: 0.06, vol: 0.32 * v, pan });
      tone({ f: 320, f2: 150, dur: 0.09, vol: 0.28 * v, pan, type: 'triangle' });
    },
    spike(v, pan) {
      v = Math.min(1, v);
      burst({ filter: 'highpass', f: 1600, q: 0.8, dur: 0.06, vol: 0.55 * v, pan });
      burst({ filter: 'bandpass', f: 700, q: 1, dur: 0.12, vol: 0.35 * v, pan });
      tone({ f: 210, f2: 60, dur: 0.16, vol: 0.45 * v, pan });
    },
    sand(v, pan) {
      burst({ filter: 'lowpass', f: 900, f2: 200, q: 0.7, dur: 0.28, vol: 0.4 * Math.min(1, v), pan, attack: 0.01 });
      tone({ f: 90, f2: 45, dur: 0.12, vol: 0.2 * Math.min(1, v), pan });
    },
    netHit(v, pan) {
      v = Math.min(1, v);
      burst({ filter: 'bandpass', f: 2200, f2: 900, q: 3, dur: 0.35, vol: 0.25 * v, pan });
      tone({ f: 140, f2: 90, dur: 0.25, vol: 0.18 * v, pan, type: 'triangle' });
    },
    // Balıklama: kuma sürtünen hışırtı
    dash(v, pan) {
      v = Math.min(1, v);
      burst({ filter: 'bandpass', f: 600, f2: 2400, q: 0.8, dur: 0.22, vol: 0.3 * v, pan, attack: 0.02 });
      burst({ filter: 'lowpass', f: 700, f2: 200, q: 0.7, dur: 0.35, vol: 0.25 * v, pan, delay: 0.12 });
    },
    // Tank: atış, sekme, patlama, mayın kurulumu
    tankFire(v, pan) {
      v = clamp(v, 0, 1);
      burst({ filter: 'bandpass', f: 1800, f2: 600, q: 1.2, dur: 0.08, vol: 0.3 * v, pan });
      tone({ f: 520, f2: 140, dur: 0.1, vol: 0.22 * v, pan, type: 'square' });
    },
    ricochet(v, pan) {
      v = clamp(v, 0, 1);
      if (v < 0.05) return;
      tone({ f: 2600, f2: 1500, dur: 0.05, vol: 0.07 * v, pan, type: 'triangle' });
    },
    boom(v, pan) {
      v = clamp(v, 0, 1);
      burst({ filter: 'lowpass', f: 1400, f2: 120, q: 0.7, dur: 0.7, vol: 0.6 * v, pan });
      tone({ f: 70, f2: 28, dur: 0.6, vol: 0.5 * v, pan, type: 'triangle' });
      burst({ filter: 'highpass', f: 2500, q: 0.8, dur: 0.12, vol: 0.18 * v, pan, delay: 0.03 });
    },
    minePlant() {
      tone({ f: 660, dur: 0.06, vol: 0.1, type: 'square' });
      tone({ f: 880, dur: 0.06, vol: 0.1, type: 'square', delay: 0.09 });
    },
    // Arayüz
    // Kart: masaya kayan kağıt hışırtısı + hafif tık
    card() {
      burst({ filter: 'highpass', f: 2600, f2: 1400, q: 0.7, dur: 0.07, vol: 0.12 });
      tone({ f: 1400, f2: 900, dur: 0.03, vol: 0.04, type: 'triangle', delay: 0.05 });
    },
    click() { tone({ f: 1100, f2: 700, dur: 0.06, vol: 0.12, type: 'triangle' }); },
    chat() { tone({ f: 988, dur: 0.08, vol: 0.06 }); tone({ f: 1319, dur: 0.1, vol: 0.05, delay: 0.06 }); },
    pop(v, pan) { tone({ f: 380, f2: 950, dur: 0.09, vol: 0.13 * clamp(v, 0, 1), pan, glide: 0.06 }); },
    toggle(on) {
      tone({ f: on ? 660 : 880, f2: on ? 990 : 520, dur: 0.12, vol: 0.12, type: 'triangle' });
    },
  };

  window.SFX = Object.assign({
    init,
    get on() { return !!ac && !muted; },
    get muted() { return muted; },
    setMuted,
    loop,
    engine: () => (ac ? new Engine() : null),
  }, Object.fromEntries(Object.entries(FX).map(([k, fn]) => [k, (...a) => { if (ac && !muted) fn(...a); }])));
})();
