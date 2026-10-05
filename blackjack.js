'use strict';
// Blackjack masası (sunucu tarafı). Tur tabanlıdır: durum her değiştiğinde hooks.change() çağrılır,
// sunucu yeni durumu herkese yollar. Krupiye sunucudur (oyuncu/bot değil): 17'ye kadar çeker, 17'de durur.
// 8 deste (416 kart, casinolardaki gibi); el başında son ~%25'e inildiyse ya da el ortasında biterse masadaki
// kartlar hariç karılır. Kalan kart sayısı oyunculara gönderilmez. Her el Dağıt ile elle başlatılır.
const crypto = require('crypto');
const { BJ } = require('./public/world.js');

class Table {
  constructor(hooks) {
    this.hooks = hooks; // { change(), settled(results), kick(id), notice(text) }
    this.seats = Array(BJ.seats).fill(null); // { id, cards, st, res, inRound, idle }
    this.dealer = [];
    this.reveal = false; // krupiyenin kapalı kartı açıldı mı
    this.phase = 'idle'; // idle | deal | turns | dealer | result
    this.turn = -1;
    this.deadline = 0; // sıradaki oyuncunun son anı
    this.nextAt = 0; // dağıtma / krupiye / yeni el zamanlayıcısı
    this.queue = []; // dağıtma sırası: koltuk no ya da 'd' (krupiye)
    this.shuffle();
  }

  shuffle() {
    const inPlay = new Set([...this.dealer, ...this.seats.flatMap((s) => (s ? s.cards : []))]);
    const d = [];
    for (let c = 0; c < 52 * BJ.decks; c++) if (!inPlay.has(c)) d.push(c);
    for (let i = d.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [d[i], d[j]] = [d[j], d[i]];
    }
    this.deck = d;
  }

  draw() {
    if (!this.deck.length) {
      this.shuffle();
      this.hooks.notice('🃏 Deste bitti, yeniden karıldı.');
    }
    return this.deck.pop();
  }

  seatOf(id) {
    return this.seats.findIndex((s) => s && s.id === id);
  }

  playing() {
    return this.seats.filter((s) => s && s.inRound);
  }

  // Oturma: boş koltuğa. El sürerken oturan bir sonraki elde oyuna girer. Hata metni ya da null döner
  sit(id, i, now) {
    if (this.seats[i]) return 'Bu koltuk dolu.';
    const cur = this.seatOf(id);
    if (cur >= 0) {
      if (this.seats[cur].inRound && this.phase !== 'result') return 'El sürüyor; bitince koltuk değiştirebilirsin.';
      this.seats[cur] = null;
    }
    this.seats[i] = { id, cards: [], st: 'wait', res: null, inRound: false, idle: 0 };
    // Masada el yokken oturan için bir sonraki el kendiliğinden başlamaz; Dağıt'a basılır
    this.hooks.change();
    return null;
  }

  leave(id, now) {
    const i = this.seatOf(id);
    if (i < 0) return;
    this.seats[i] = null;
    if (!this.seats.some(Boolean)) {
      // Masada kimse kalmadı: el iptal
      this.phase = 'idle';
      this.dealer = [];
      this.turn = -1;
      this.queue = [];
    } else if ((this.phase === 'deal' || this.phase === 'turns') && !this.playing().length) {
      // Eldeki herkes kalktı, bekleyenler var: el iptal, Dağıt ile yenisi başlar
      this.dealer = [];
      this.turn = -1;
      this.queue = [];
      this.phase = 'idle';
    } else if (this.phase === 'turns' && this.turn === i) this.nextTurn(now);
    this.hooks.change();
  }

  // Yeni el sadece Dağıt ile başlar (masa boşta ya da önceki elin sonucu gösteriliyorken)
  canStart() {
    return (this.phase === 'idle' || this.phase === 'result') && this.seats.some(Boolean);
  }

  start(now) {
    for (const s of this.seats) if (s) { s.cards = []; s.inRound = false; }
    this.dealer = [];
    if (this.deck.length < BJ.reshuffleBelow) {
      this.shuffle();
      this.hooks.notice('🃏 Deste karıldı.');
    }
    this.queue = [];
    const order = [];
    for (let i = 0; i < BJ.seats; i++) {
      const s = this.seats[i];
      if (!s) continue;
      s.inRound = true;
      s.st = 'play';
      s.res = null;
      order.push(i);
    }
    for (let k = 0; k < 2; k++) this.queue.push(...order, 'd');
    this.reveal = false;
    this.turn = -1;
    this.phase = 'deal';
    this.nextAt = now + BJ.dealMs;
    this.hooks.change();
  }

  nextTurn(now) {
    for (let i = this.turn + 1; i < BJ.seats; i++) {
      const s = this.seats[i];
      if (s && s.inRound && s.st === 'play') {
        this.turn = i;
        this.deadline = now + BJ.turnSeconds * 1000;
        return;
      }
    }
    this.turn = -1;
    this.phase = 'dealer';
    this.nextAt = now + BJ.dealerMs;
  }

  // Oyuncu hamlesi: 'hit' (kart çek) ya da 'stand' (dur). Hata metni ya da null döner
  act(id, a, now) {
    const i = this.seatOf(id);
    if (i < 0) return 'Masada değilsin.';
    if (this.phase !== 'turns' || i !== this.turn) return 'Sıra sende değil.';
    const s = this.seats[i];
    s.idle = 0;
    if (a === 'hit') {
      s.cards.push(this.draw());
      const v = BJ.value(s.cards).t;
      if (v > 21) {
        s.st = 'bust';
        this.nextTurn(now);
      } else if (v === 21) {
        s.st = 'stand';
        this.nextTurn(now);
      } else this.deadline = now + BJ.turnSeconds * 1000;
    } else {
      s.st = 'stand';
      this.nextTurn(now);
    }
    this.hooks.change();
    return null;
  }

  settle(now) {
    const dv = BJ.value(this.dealer).t, dbj = BJ.isBlackjack(this.dealer);
    const results = [];
    for (const s of this.playing()) {
      const pv = BJ.value(s.cards).t;
      if (s.st === 'bust') s.res = 'lose';
      else if (s.st === 'bj') s.res = dbj ? 'push' : 'bj';
      else if (dbj) s.res = 'lose';
      else if (dv > 21 || pv > dv) s.res = 'win';
      else if (pv < dv) s.res = 'lose';
      else s.res = 'push';
      results.push({ id: s.id, res: s.res });
    }
    this.phase = 'result'; // sonuçlar masada kalır, yeni el Dağıt ile
    this.hooks.settled(results);
    this.hooks.change();
  }

  step(now) {
    if (this.phase === 'deal' && now >= this.nextAt) {
      // Sıradaki kartı ver (kalkmış oyuncunun sırası atlanır)
      let item;
      do item = this.queue.shift();
      while (item !== undefined && item !== 'd' && !(this.seats[item] && this.seats[item].inRound));
      if (item === 'd') this.dealer.push(this.draw());
      else if (item !== undefined) this.seats[item].cards.push(this.draw());
      if (!this.queue.length) {
        for (const s of this.playing()) if (BJ.isBlackjack(s.cards)) s.st = 'bj';
        this.phase = 'turns';
        this.turn = -1;
        this.nextTurn(now);
      } else this.nextAt = now + BJ.dealMs;
      this.hooks.change();
    } else if (this.phase === 'turns' && now >= this.deadline) {
      // Süre doldu: "Dur" sayılır. Üst üste birkaç el hiç oynamayan masadan kaldırılır
      const s = this.seats[this.turn];
      s.st = 'stand';
      s.idle++;
      this.nextTurn(now);
      this.hooks.change();
      if (s.idle >= BJ.idleKick) this.hooks.kick(s.id);
    } else if (this.phase === 'dealer' && now >= this.nextAt) {
      const alive = this.playing().some((s) => s.st === 'stand');
      if (!this.reveal) this.reveal = true;
      else if (alive && BJ.value(this.dealer).t < 17) this.dealer.push(this.draw());
      else return this.settle(now);
      this.nextAt = now + BJ.dealerMs;
      this.hooks.change();
    }
  }

  snapshot(now) {
    const left = this.phase === 'turns' ? this.deadline - now : 0;
    return {
      t: 'bj', ph: this.phase, turn: this.turn, left: Math.max(0, Math.round(left)),
      d: this.dealer.map((c, i) => (i === 1 && !this.reveal ? -1 : c)), // kapalı kart gönderilmez
      s: this.seats.map((s) => s && { id: s.id, c: s.cards, st: s.st, r: s.res, w: !s.inRound }),
    };
  }
}

module.exports = { Table };
