import { h, paintIcon } from './dom.js';

// Light "wave lines" in the bottom of each folder card.
const WAVES = (() => {
  const lines = [];
  for (let k = 0; k < 10; k++) {
    let d = '';
    for (let x = 0; x <= 400; x += 10) {
      const y = 78 - k * 3.2 + Math.sin((x / 400) * Math.PI * 2.2 + k * 0.32) * (14 + k * 1.6);
      d += `${x ? 'L' : 'M'}${x},${y.toFixed(1)}`;
    }
    lines.push(`<path d="${d}" fill="none" stroke="currentColor" stroke-width="0.9" stroke-opacity="${(0.18 + k * 0.05).toFixed(2)}"/>`);
  }
  let fill = 'M0,120';
  for (let x = 0; x <= 400; x += 10) fill += `L${x},${(96 + Math.sin((x / 400) * Math.PI * 2 + 1.2) * 14).toFixed(1)}`;
  fill += 'L400,120Z';
  return `<svg class="fcard-waves" viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true"><path d="${fill}" fill="currentColor" fill-opacity="0.16"/>${lines.join('')}</svg>`;
})();

export function folderCard(folder) {
  const iconEl = h('div', { class: 'fcard-icon', 'aria-hidden': 'true' });
  paintIcon(iconEl, folder.icon);
  return h(
    'div',
    { class: 'fcard' },
    h(
      'div',
      { class: 'fcard-body' },
      h('div', { class: 'fcard-back' }),
      h(
        'div',
        { class: 'fcard-front', html: WAVES },
        iconEl,
        h('h2', { class: 'fcard-title' }, folder.title),
        folder.description ? h('p', { class: 'fcard-desc' }, folder.description) : null,
      ),
    ),
  );
}
