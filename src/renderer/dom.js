// Tiny DOM helpers. Text is always set through textContent / createTextNode (never innerHTML), so user-provided
// strings such as rehearsal titles cannot inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(el, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'ref' && typeof v === 'function') v(el);
    else if (k in el && !(el instanceof SVGElement) && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function mount(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}

export function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

// Two-step destructive button: first click arms it, second click within `ms` runs `action`.
export function confirmButton({ label, armedLabel, className = 'btn danger', ms = 4000, action, title }) {
  let armed = false, timer = null;
  const btn = h('button', { class: className, type: 'button', title }, label);
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.classList.add('armed');
      btn.textContent = armedLabel;
      timer = setTimeout(() => { armed = false; btn.classList.remove('armed'); btn.textContent = label; }, ms);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    try { await action(); } finally { btn.disabled = false; armed = false; btn.classList.remove('armed'); btn.textContent = label; }
  });
  return btn;
}
