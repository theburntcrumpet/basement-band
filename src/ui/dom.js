// Small DOM helpers: element builder, toast, modal, context menu, knobs, drag tracking.

export const $ = sel => document.querySelector(sel);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function modal(content, { dismissable = true } = {}) {
  const root = $('#modal');
  root.replaceChildren(h('div', { class: 'dialog' }, content));
  root.classList.remove('hidden');
  const close = () => { root.classList.add('hidden'); root.replaceChildren(); root.onclick = null; };
  root.onclick = e => { if (dismissable && e.target === root) close(); };
  return close;
}

export function confirmDialog(title, text, ok = 'OK') {
  return new Promise(resolve => {
    let close;
    const done = v => { close(); resolve(v); };
    close = modal([
      h('h2', {}, title),
      h('p', { style: { color: 'var(--dim)', margin: 0 } }, text),
      h('div', { class: 'actions' },
        h('button', { class: 'text', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: 'text accent', onclick: () => done(true) }, ok)),
    ]);
  });
}

// Asks for a number in a small dialog; resolves to the number, or null if cancelled.
export function promptNumber(title, label, value, min, max) {
  return new Promise(resolve => {
    let close;
    const input = h('input', { type: 'number', value, min, max, step: 0.1, class: 'num-input', style: { width: '100px' } });
    const done = ok => {
      const v = Number(input.value);
      close();
      resolve(ok && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : null);
    };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    close = modal([
      h('h2', {}, title),
      h('label', { class: 'field inline' }, h('span', {}, label), input),
      h('div', { class: 'actions' },
        h('button', { class: 'text', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: 'text accent', onclick: () => done(true) }, 'OK')),
    ]);
    input.focus();
    input.select();
  });
}

export function contextMenu(x, y, items) {
  const menu = $('#menu');
  menu.replaceChildren(...items.map(it => it === '-' ? h('hr') : h('button', {
    onclick: () => { hide(); it.action(); },
  }, h('span', {}, it.label), it.key ? h('kbd', {}, it.key) : null)));
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  const hide = () => { menu.classList.add('hidden'); removeEventListener('mousedown', outside, true); };
  const outside = e => { if (!menu.contains(e.target)) hide(); };
  setTimeout(() => addEventListener('mousedown', outside, true));
}

// Tracks a mouse drag from a mousedown event. onMove(dx, dy, e), onUp(e, moved).
export function drag(down, onMove, onUp) {
  const x0 = down.clientX, y0 = down.clientY;
  let moved = false;
  const move = e => {
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    moved = true;
    onMove?.(dx, dy, e);
  };
  const up = e => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    onUp?.(e, moved);
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

// Rotary knob. value in [min,max]; onInput fires while dragging, onCommit when released.
export function knob({ label, value, min = 0, max = 1, format = v => Math.round(v * 100) + '%', onInput, onStart, onCommit, center }) {
  const dial = h('div', { class: 'dial' }, h('div', { class: 'ring' }));
  const val = h('div', { class: 'val' });
  const el = h('div', { class: 'knob' }, dial, h('label', {}, label), val);
  const paint = v => {
    const p = (v - min) / (max - min);
    dial.style.setProperty('--rot', `${-135 + p * 270}deg`);
    dial.style.setProperty('--pct', `${p * 75}%`);
    val.textContent = format(v);
  };
  let current = value;
  paint(current);
  dial.addEventListener('mousedown', e => {
    e.preventDefault();
    const start = current;
    onStart?.();
    drag(e, (_dx, dy, ev) => {
      const range = max - min;
      current = Math.max(min, Math.min(max, start - dy * range / (ev.shiftKey ? 600 : 150)));
      paint(current);
      onInput?.(current);
    }, () => onCommit?.(current));
  });
  dial.addEventListener('dblclick', () => {
    current = center ?? (min + max) / 2;
    paint(current);
    onStart?.();
    onInput?.(current);
    onCommit?.(current);
  });
  return el;
}

export function canvas2d(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// Theme colours for canvas drawing, read from the CSS variables of the active theme.
let paletteCache = null, paletteTheme = null;
export function palette() {
  const theme = document.documentElement.dataset.theme || 'dark';
  if (paletteCache && paletteTheme === theme) return paletteCache;
  const css = getComputedStyle(document.documentElement);
  const v = name => css.getPropertyValue(name).trim();
  // e.g. palette().cvRowScale reads --cv-row-scale (cached until the theme changes).
  const resolved = {};
  paletteCache = new Proxy(resolved, { get: (o, key) => (key in o ? o[key] : (o[key] = v('--' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())))) });
  paletteTheme = theme;
  return paletteCache;
}
