import octicons from '@primer/octicons';

// Octicons that the page itself uses (buttons, list badges, and so on).
export const UI_ICONS = ['arrow-left', 'check-circle-fill', 'chevron-left', 'chevron-right', 'file', 'file-directory', 'home', 'play', 'screen-full', 'video', 'alert', 'sync', 'download', 'gear', 'mute', 'unmute'];

export function svg(name) {
  const icon = octicons[name];
  return icon ? icon.toSVG({ height: 24, 'aria-hidden': 'true' }) : '';
}

// A solid play triangle for the round play buttons. The Octicon "play" has its own circle.
// The triangle's center of mass is at the middle of the box, so it looks centered in a circle.
const PLAY =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M8.6 5.6v12.8a.8.8 0 0 0 1.2.7l10.1-6.4a.8.8 0 0 0 0-1.4L9.8 4.9a.8.8 0 0 0-1.2.7Z"/></svg>';

export const uiIcons = () => ({ ...Object.fromEntries(UI_ICONS.map((n) => [n, svg(n)])), play: PLAY });
