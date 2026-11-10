// Small DOM helpers shared by the admin page and the kiosk.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// UI icons (Primer Octicons) come from the server one time.
let uiIcons = {};
export async function loadUiIcons() {
  uiIcons = await fetch('/icons.json').then((r) => r.json());
  fillIcons(document);
}
export const iconSvg = (name) => uiIcons[name] ?? '';
export function fillIcons(root) {
  for (const el of $$('[data-icon]', root)) el.innerHTML = iconSvg(el.dataset.icon);
}
export const icon = (name) => h('span', { class: 'icon', html: iconSvg(name), 'aria-hidden': 'true' });

// An SVG as a CSS mask, so CSS can paint it with a gradient.
export const svgMask = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg.replace(/<svg /, '<svg xmlns="http://www.w3.org/2000/svg" '))}")`;

// Paints a catalog icon ({ svg } or { url }) into el.
export function paintIcon(el, iconRef) {
  el.classList.toggle('is-image', !!iconRef?.url);
  el.replaceChildren();
  if (iconRef?.url) el.append(h('img', { src: iconRef.url, alt: '', draggable: 'false' }));
  else if (iconRef?.svg) el.style.setProperty('--mask', svgMask(iconRef.svg));
}

// Applies a theme and remembers it on this machine for the next page load.
export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('kiosk-theme', theme);
  } catch {
    // Storage can be off (for example, in a private window). The server setting still applies.
  }
}

export function formatTime(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '';
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

// "r g b" triples from a CSS custom property such as --palette or --active.
export function cssTriples(name, el = document.documentElement) {
  return getComputedStyle(el)
    .getPropertyValue(name)
    .split(',')
    .map((s) => s.trim().split(/\s+/).map(Number))
    .filter((t) => t.length === 3 && t.every(Number.isFinite));
}
