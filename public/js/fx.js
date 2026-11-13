// Decorative motion: toran, mandala, temple doors, floating diyas, letter reveals, petal bursts.
// Everything here is ornamental and is skipped (or rendered still) in lite mode.
import { h, device } from './core.js';

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** Hanging toran: mango leaves alternating with marigolds, each swaying on its own beat. */
export function toran(count = 16) {
  const row = h('div', { class: 'toran', 'aria-hidden': 'true' });
  for (let i = 0; i < count; i++) {
    const leaf = i % 2 === 0;
    row.append(h('span', {
      class: leaf ? 'tl-leaf' : 'tl-flower',
      style: { animationDelay: `${(i % 7) * -0.45}s`, animationDuration: `${3.2 + (i % 5) * 0.35}s` },
    }));
  }
  return row;
}

/** Concentric lotus-petal mandala drawn as thin brass lines. */
export function mandala({ rings = [[12, 46, 30], [16, 70, 22], [24, 92, 16]], cls = 'mandala' } = {}) {
  const svg = svgEl('svg', { viewBox: '-100 -100 200 200', class: cls, 'aria-hidden': 'true' });
  for (const [n, r, w] of rings) {
    const g = svgEl('g');
    for (let k = 0; k < n; k++) {
      const a = (360 / n) * k;
      // a pointed petal from radius r-w to r
      const path = svgEl('path', {
        d: `M0 ${-(r - w)} C ${w * 0.55} ${-(r - w * 0.55)}, ${w * 0.32} ${-(r - 4)}, 0 ${-r} C ${-w * 0.32} ${-(r - 4)}, ${-w * 0.55} ${-(r - w * 0.55)}, 0 ${-(r - w)}Z`,
        transform: `rotate(${a})`,
      });
      g.append(path);
    }
    svg.append(g);
    svg.append(svgEl('circle', { r: r - w, fill: 'none' }));
  }
  svg.append(svgEl('circle', { r: 6 }));
  return svg;
}

/** Two carved doors that open to reveal the page. Removed after the animation. */
export function templeDoors(onOpen) {
  if (device.lite) { onOpen?.(); return null; }
  const doors = h('div', { class: 'doors', 'aria-hidden': 'true' },
    h('div', { class: 'door l' }, h('i', { class: 'knob' })),
    h('div', { class: 'door r' }, h('i', { class: 'knob' })),
    h('div', { class: 'door-glow' }));
  setTimeout(() => { doors.classList.add('open'); onOpen?.(); }, 650);
  setTimeout(() => doors.remove(), 2600);
  return doors;
}

/** Clay diyas that drift across the river at the bottom of the gate. */
export function floatingDiyas(n = 5) {
  if (device.lite) return [];
  return Array.from({ length: n }, (_, i) => h('div', {
    class: 'float-diya',
    style: {
      bottom: `${1 + (i % 3) * 2.5}%`,
      animationDuration: `${26 + i * 7}s`,
      animationDelay: `${-i * 9}s`,
      '--s': String(0.7 + (i % 3) * 0.18),
    },
  }, h('i', { class: 'flame' }), h('b', { class: 'bowl' }), h('u', { class: 'reflect' })));
}

/** Embers rising from the river. */
export function embers(n = 14) {
  if (device.lite) return [];
  return Array.from({ length: n }, (_, i) => h('i', {
    class: 'ember',
    style: { left: `${(i * 37) % 100}%`, animationDelay: `${(i * 0.83) % 9}s`, animationDuration: `${9 + (i % 5) * 2}s` },
  }));
}

/** Splits text into spans that rise in one after another. */
export function letters(text, baseDelay = 0, step = 0.055) {
  const frag = [];
  [...text].forEach((ch, i) => {
    frag.push(ch === ' ' ? ' ' : h('span', { class: 'ltr', style: { animationDelay: `${baseDelay + i * step}s` } }, ch));
  });
  return frag;
}

/** Radial burst of petals and sparks from a point (defaults to screen centre). */
export function burst({ x = innerWidth / 2, y = innerHeight / 2, n = 28 } = {}) {
  if (device.lite) return;
  const box = h('div', { class: 'burst', 'aria-hidden': 'true', style: { left: x + 'px', top: y + 'px' } });
  const kinds = ['b-marigold', 'b-rose', 'b-jasmine', 'b-spark'];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.3;
    const d = 90 + Math.random() * 140;
    box.append(h('i', {
      class: kinds[i % kinds.length],
      style: { '--tx': `${Math.cos(a) * d}px`, '--ty': `${Math.sin(a) * d + 40}px`, '--r': `${Math.random() * 540 - 270}deg`, animationDelay: `${Math.random() * 0.12}s` },
    }));
  }
  box.append(h('b', { class: 'b-ring' }));
  document.body.append(box);
  setTimeout(() => box.remove(), 2200);
}

/** Small ripple where a button was pressed. */
export function ripple(e) {
  if (device.lite) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const dot = h('span', { class: 'ripple', style: { left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px` } });
  el.append(dot);
  setTimeout(() => dot.remove(), 650);
}

/** Petals placed on an ellipse (percent of the parent box) that light up as capture progresses. */
export function petalRing(total = 24, { cx = 50, cy = 47, rx = 37, ry = 38 } = {}) {
  const ring = h('div', { class: 'petal-ring', 'aria-hidden': 'true' });
  for (let i = 0; i < total; i++) {
    const a = (Math.PI * 2 * i) / total;
    ring.append(h('i', { style: { left: `${cx + rx * Math.sin(a)}%`, top: `${cy - ry * Math.cos(a)}%`, '--a': `${(360 / total) * i}deg`, transitionDelay: `${(i % 8) * 25}ms` } }));
  }
  ring.setProgress = (k) => {
    const lit = Math.round(total * k);
    [...ring.children].forEach((p, i) => p.classList.toggle('lit', i < lit));
  };
  return ring;
}
