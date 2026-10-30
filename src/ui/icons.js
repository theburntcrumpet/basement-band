// Toolbar and button icons, drawn here rather than typed as characters: symbols like ⏮ ▶ ● come from
// whichever font each system falls back to, so they differ in size and sit off-centre.

const line = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  rewind: '<path d="M2.5 3h2v10h-2zM13.5 3v10L5.5 8z"/>',
  play: '<path d="M4 2.5v11L13.5 8z"/>',
  stop: '<path d="M3.5 3.5h9v9h-9z"/>',
  record: '<circle cx="8" cy="8" r="5"/>',
  cycle: `<path ${line} d="M13 8a5 5 0 1 1-1.5-3.55M11.8 1.5v3h-3"/>`,
  library: '<path d="M2 3h2.5v10H2zM6 3h8v2H6zM6 7h8v2H6zM6 11h8v2H6z"/>',
  knob: `<circle ${line} cx="8" cy="8" r="5.5"/><path ${line} d="M8 8 11 4.8"/>`,
  pencil: '<path d="m11.3 1.9 2.8 2.8-8.6 8.6-3.5.7.7-3.5z"/>',
  metronome: `<path ${line} d="M6 2.5h4l2.5 11h-9zM8 10.5l4.5-6"/>`,
  tuner: `<path ${line} d="M5.5 2v5a2.5 2.5 0 0 0 5 0V2M8 9.5V14"/>`,
  keyboard: `<rect ${line} x="1.5" y="4" width="13" height="8.5" rx="1.2"/><path ${line} d="M4 7h.01M6.7 7h.01M9.3 7h.01M12 7h.01M5 10h6"/>`,
  gear: '<circle cx="8" cy="8" r="4.7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="2.3 1.39"/><circle cx="8" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  close: `<path ${line} d="m4 4 8 8M12 4l-8 8"/>`,
  plus: `<path ${line} d="M8 3v10M3 8h10"/>`,
  right: `<path ${line} d="m6 3.5 4.5 4.5L6 12.5"/>`,
  down: `<path ${line} d="M3.5 6 8 10.5 12.5 6"/>`,
  pointer: '<path d="m3.5 2 9.5 6.5-4.2.8 2.3 4-1.8 1-2.3-4-3 3z"/>',
  eraser: `<path ${line} d="m6 13 7.5-7.5-3-3L2.5 10.5 5 13h9M5 8l3 3"/>`,
  box: `<rect ${line} stroke-dasharray="2.2 2.2" x="2.5" y="2.5" width="11" height="11" rx="1"/>`,
  headphones: `<path ${line} d="M2.5 11V8a5.5 5.5 0 0 1 11 0v3"/><path d="M1.5 9.5h3v4.5h-3zM11.5 9.5h3v4.5h-3z"/>`,
  dice: `<rect ${line} x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 4.2h1.6v1.6H5zM9.4 4.2H11v1.6H9.4zM7.2 7.2h1.6v1.6H7.2zM5 10.2h1.6v1.6H5zM9.4 10.2H11v1.6H9.4z"/>`,
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

// Fills every <button data-icon="name"> in the page.
export function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => el.replaceChildren(icon(el.dataset.icon)));
}
