'use strict';
// Small DOM helpers. Text always goes in as text nodes, never as markup.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'line', 'rect', 'circle', 'text', 'polygon', 'polyline', 'title']);

function append(el, child) {
  if (child == null || child === false || child === true) return;
  if (Array.isArray(child)) child.forEach((c) => append(el, c));
  else if (child instanceof Node) el.appendChild(child);
  else el.appendChild(document.createTextNode(String(child)));
}

function h(tag, attrs, ...children) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') {
      // custom properties (--c) only take through setProperty
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && !SVG_TAGS.has(tag)) el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'open' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

const dollars = (n) => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const dollarsRange = (r) => (Math.abs(r.hi - r.lo) < 1 ? dollars(r.lo) : `${dollars(r.lo)} to ${dollars(r.hi)}`);

// "1,234.00", "$1234", " 12 " -> number; "" -> null; junk -> NaN
function parseNumber(text) {
  const s = String(text == null ? '' : text).replace(/[$,%\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

module.exports = { h, dollars, dollarsRange, parseNumber, clear };
