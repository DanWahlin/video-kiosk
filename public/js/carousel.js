import { cssTriples } from './dom.js';

const mod = (a, n) => ((a % n) + n) % n;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A 3D "cover flow" of folder cards. `pos` is a continuous position (1.5 means halfway
// between cards 1 and 2), so drags and animations move smoothly between cards.
// With 6 or more cards the carousel loops; with fewer it stops at the ends.
export class Carousel {
  constructor(stage, track, { onOpen, onIndex } = {}) {
    this.stage = stage;
    this.track = track;
    this.onOpen = onOpen;
    this.onIndex = onIndex;
    this.cards = [];
    this.pos = 0;
    this.target = 0;
    this.drag = null;
    this.running = false;
    this.lastIndex = -1;
    this.tick = this.tick.bind(this);
    stage.addEventListener('pointerdown', (e) => this.down(e));
    stage.addEventListener('pointermove', (e) => this.move(e));
    stage.addEventListener('pointerup', (e) => this.up(e, true));
    stage.addEventListener('pointercancel', (e) => this.up(e, false));
    stage.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    new ResizeObserver(() => this.measure()).observe(stage);
  }

  setCards(cards) {
    this.cards = cards;
    this.n = cards.length;
    this.wrap = this.n >= 6;
    this.track.replaceChildren(...cards);
    this.pos = this.target = this.home;
    this.lastIndex = -1;
    this.measure();
    this.refreshColors();
  }

  get home() {
    return Math.floor((this.n - 1) / 2);
  }

  get index() {
    const i = Math.round(this.pos);
    return this.wrap ? mod(i, this.n) : clamp(i, 0, this.n - 1);
  }

  measure() {
    if (!this.cards.length) return;
    this.w = this.cards[0].offsetWidth || 300;
    this.render();
  }

  refreshColors() {
    this.palette = cssTriples('--palette');
    if (!this.palette.length) this.palette = [[90, 120, 255]];
    this.active = cssTriples('--active')[0] ?? [34, 211, 238];
    this.render();
  }

  colorFor(i) {
    return this.palette[i % this.palette.length];
  }

  offset(i, pos = this.pos) {
    const d = i - pos;
    return this.wrap ? mod(d + this.n / 2, this.n) - this.n / 2 : d;
  }

  render() {
    const w = this.w;
    const s1 = w * 1.0;
    const s2 = w * 0.8;
    this.cards.forEach((card, i) => {
      const d = this.offset(i);
      const ad = Math.abs(d);
      const x = Math.sign(d) * (Math.min(ad, 1) * s1 + Math.max(ad - 1, 0) * s2);
      const scale = 1 - 0.2 * Math.min(ad, 2.5);
      const z = -ad * w * 0.35;
      const rot = clamp(-d * 18, -36, 36);
      const opacity = ad <= 2.3 ? 1 : Math.max(0, 1 - (ad - 2.3) / 0.5);
      const focus = Math.max(0, 1 - ad);
      const f = Math.pow(focus, 0.8);
      const [r, g, b] = this.colorFor(i).map((c, k) => Math.round(c + (this.active[k] - c) * f));
      card.style.transform = `translate3d(${x.toFixed(1)}px,0,${z.toFixed(1)}px) rotateY(${rot.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
      card.style.opacity = opacity.toFixed(3);
      card.style.zIndex = String(1000 - Math.round(ad * 100));
      card.style.visibility = opacity < 0.01 ? 'hidden' : '';
      card.style.setProperty('--focus', focus.toFixed(3));
      card.style.setProperty('--c', `${r} ${g} ${b}`);
      card.classList.toggle('is-center', ad < 0.5);
      card.setAttribute('aria-selected', String(ad < 0.5));
    });
    const index = this.index;
    if (index !== this.lastIndex) {
      this.lastIndex = index;
      this.onIndex?.(index);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.tick);
  }

  tick(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.drag?.moved) {
      // Exponential ease: fast at first, then a long, soft landing.
      this.pos += (this.target - this.pos) * (1 - Math.exp(-dt * 7));
      if (Math.abs(this.target - this.pos) < 0.0005) this.pos = this.target;
    }
    this.render();
    if (this.pos !== this.target || this.drag?.moved) requestAnimationFrame(this.tick);
    else this.running = false;
  }

  go(i, { instant = false } = {}) {
    if (this.wrap) this.target = Math.round(this.target) + this.offset(i, Math.round(this.target));
    else this.target = clamp(i, 0, this.n - 1);
    if (instant) {
      this.pos = this.target;
      this.render();
    } else this.start();
  }

  next() {
    if (this.wrap) this.target = Math.round(this.target) + 1;
    else this.target = this.target >= this.n - 1 ? 0 : Math.round(this.target) + 1;
    this.start();
  }

  prev() {
    if (this.wrap) this.target = Math.round(this.target) - 1;
    else this.target = this.target <= 0 ? this.n - 1 : Math.round(this.target) - 1;
    this.start();
  }

  down(e) {
    if (e.button > 0 || this.drag) return;
    this.drag = { id: e.pointerId, x: e.clientX, startPos: this.pos, lastX: e.clientX, lastT: e.timeStamp, vel: 0, moved: false, card: e.target.closest('.fcard') };
  }

  move(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    // Fingers jitter more than a mouse, so a touch needs a longer move to count as a drag.
    if (!d.moved && Math.abs(dx) > (e.pointerType === 'touch' ? 14 : 8)) {
      d.moved = true;
      this.stage.setPointerCapture(e.pointerId);
      this.stage.classList.add('is-dragging');
      this.start();
    }
    if (!d.moved) return;
    let p = d.startPos - dx / this.w;
    if (!this.wrap) {
      // Rubber band past the first and last cards.
      if (p < 0) p *= 0.35;
      if (p > this.n - 1) p = this.n - 1 + (p - (this.n - 1)) * 0.35;
    }
    const dt = Math.max(1, e.timeStamp - d.lastT) / 1000;
    d.vel = d.vel * 0.6 + (-(e.clientX - d.lastX) / this.w / dt) * 0.4;
    d.lastX = e.clientX;
    d.lastT = e.timeStamp;
    this.pos = this.target = p;
  }

  up(e, isClick) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.stage.classList.remove('is-dragging');
    if (d.moved) {
      let projected = Math.round(this.pos + clamp(d.vel, -10, 10) * 0.12);
      // Any clear swipe moves at least one card, and one swipe moves at most two.
      const start = Math.round(d.startPos);
      const moved = this.pos - d.startPos;
      if (projected === start && Math.abs(moved) > 0.12) projected = start + Math.sign(moved);
      projected = clamp(projected, start - 2, start + 2);
      this.target = this.wrap ? projected : clamp(projected, 0, this.n - 1);
      this.start();
      return;
    }
    if (!isClick || !d.card) return;
    // A tap on any card opens it, not only the card in the center.
    const i = this.cards.indexOf(d.card);
    if (i >= 0) this.onOpen?.(i);
  }

  wheel(e) {
    e.preventDefault();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 4 || performance.now() - (this.lastWheel ?? 0) < 350) return;
    this.lastWheel = performance.now();
    delta > 0 ? this.next() : this.prev();
  }
}
