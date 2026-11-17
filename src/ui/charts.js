'use strict';
// The chart: stacked bars, one column per plan.
// Marks carry colour; all text stays in text colours.

const { h, dollars, dollarsRange } = require('./dom.js');

// ---- one shared tooltip --------------------------------------------------------------------
let tip = null;
function tooltip() {
  if (!tip) {
    tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
    document.body.appendChild(tip);
  }
  return tip;
}
function showTip(content, x, y) {
  const t = tooltip();
  while (t.firstChild) t.removeChild(t.firstChild);
  t.appendChild(content);
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
  let top = y - r.height - 12;
  if (top < 8) top = y + 16;
  t.style.left = left + window.scrollX + 'px';
  t.style.top = top + window.scrollY + 'px';
}
function hideTip() {
  if (tip) tip.hidden = true;
}
function attachTip(el, make) {
  const at = (e) => {
    const r = el.getBoundingClientRect();
    const x = e && e.clientX != null && e.type !== 'focus' ? e.clientX : r.left + r.width / 2;
    showTip(make(), x, r.top);
  };
  el.addEventListener('pointerenter', at);
  el.addEventListener('pointermove', at);
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', at);
  el.addEventListener('blur', hideTip);
}

function niceTicks(min, max, target) {
  const span = max - min || 1;
  const raw = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => span / s <= target + 1) || 10 * pow;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) out.push(v);
  return out;
}

// ---- stacked bars: the front ---------------------------------------------------------------
// One column per plan, named on the axis. Colour says what kind of money a segment is, never
// which plan it belongs to. The solid stack is the year picked with the switch (typical or
// catastrophic); a dashed outline runs on up to the worst case. FSA or HSA money beyond
// what the year's care uses is a dotted segment on top: set aside, not counted in the total.
const PLOT_H = 300; // px, matches .cols in the stylesheet
const SEGMENTS = [
  ['premium', 'Premiums'],
  ['ded', 'Deductible'],
  ['cc', 'Copays and coinsurance'],
  ['extra', 'Charges no cap covers'],
];
const YEAR_WORDS = { expected: 'typical year', bad: 'catastrophic year' };

// Remember where each mark was, so a change of answers or of year glides instead of jumping.
const lastPlace = new Map();
function place(el, key, bottom, height) {
  const prev = lastPlace.get(key);
  lastPlace.set(key, { bottom, height });
  const set = (b, hgt) => {
    el.style.bottom = b + '%';
    if (hgt != null) el.style.height = hgt + '%';
  };
  if (!prev || typeof requestAnimationFrame !== 'function') return set(bottom, height);
  set(prev.bottom, height == null ? null : prev.height);
  requestAnimationFrame(() => requestAnimationFrame(() => set(bottom, height)));
}

// out: result of outlook.evaluate.
// ctx: { priority, picked (Set of plan ids that win on it), view, viewLabel, scenario, seriousLabel }
function stackedBars(out, ctx) {
  const plans = out.plans;
  const sKey = YEAR_WORDS[ctx.scenario] ? ctx.scenario : 'expected';
  const priority = ctx.priority;
  const picked = ctx.picked || new Set();
  const tops = plans.map((p) => {
    return Math.max(p.scenarios.ceiling.hi, p.scenarios.bad.hi, p.scenarios[sKey].hi + p.scenarios[sKey].parts.aside);
  });
  const ticks = niceTicks(0, Math.max(...tops), 4);
  const max = Math.max(Math.max(...tops), ticks[ticks.length - 1]) || 1;
  const pct = (v) => (v / max) * 100;
  const px = (v) => (v / max) * PLOT_H;
  const compact = max >= 10000;
  const tickLabel = (t) => (t === 0 ? '$0' : compact ? '$' + (t / 1000).toLocaleString('en-US') + 'K' : dollars(t));

  const used = new Set(['premium']);
  let anyAside = false;
  let anyOpen = false;

  const cols = h('div', { class: 'cols' });
  cols.appendChild(h('div', { class: 'ygrid', 'aria-hidden': 'true' }, ticks.map((t) => h('i', { style: { bottom: pct(t) + '%' } }, h('span', null, tickLabel(t))))));
  const labels = h('div', { class: 'xlabels' });

  plans.forEach((p) => {
    const sc = p.scenarios[sKey];
    const parts = sc.parts;
    // The plan that wins on what matters most gets a band down its column; the figure that
    // matters for that choice is emphasised on it alone.
    const pick = picked.has(p.id);
    const dim = p.neverCheapest && !pick;
    const col = h('div', { class: 'col' + (dim ? ' dim' : '') + (pick ? ' pick' : ''), role: 'group', 'aria-label': `${p.name}, ${YEAR_WORDS[sKey]}` });
    const bar = h('div', { class: 'bar-area' });
    const hedge = p.atLeast && sKey !== 'bad';

    // The solid stack.
    let y = 0;
    let topSeg = null;
    for (const [key, name] of SEGMENTS) {
      const v = parts[key];
      if (!(v > 0.5)) continue;
      used.add(key);
      const seg = h('div', { class: `seg seg-${key}`, tabindex: '0', role: 'img', 'aria-label': `${p.name}, ${YEAR_WORDS[sKey]}, ${name}: ${dollars(v)}` }, px(v) >= 19 ? h('span', null, dollars(v)) : null);
      place(seg, `${p.id}:${key}`, pct(y), pct(v));
      attachTip(seg, () => segTip(p, sKey, key, name, v, ctx));
      bar.appendChild(seg);
      y += v;
      topSeg = seg;
    }
    // Whatever depends on a plan fact the guide leaves open sits on top, hatched.
    if (sc.hi - sc.lo >= 1) {
      anyOpen = true;
      const seg = h('div', { class: 'seg seg-open', tabindex: '0', role: 'img', 'aria-label': `${p.name}: up to ${dollars(sc.hi - sc.lo)} more, depending on an open plan question` });
      place(seg, `${p.id}:open`, pct(sc.lo), pct(sc.hi - sc.lo));
      attachTip(seg, () => h('div', null, h('div', { class: 'tip-value' }, `up to ${dollars(sc.hi - sc.lo)} more`), h('div', { class: 'tip-label' }, `${p.short}: depends on a plan fact`), h('div', { class: 'tip-note' }, p.open.map((u) => u.text).join('; '))));
      bar.appendChild(seg);
      topSeg = seg;
    }
    // Account money beyond what this year's care uses: dotted, on top, not part of the total.
    const aside = parts.account && parts.aside > 0.5 ? parts.aside : 0;
    if (aside) {
      anyAside = true;
      const acct = parts.account;
      const seg = h('div', { class: 'seg seg-aside', tabindex: '0', role: 'img', 'aria-label': `${p.name}: ${accountWords(acct, ctx)}` }, px(aside) >= 19 ? h('span', null, dollars(aside)) : null);
      place(seg, `${p.id}:aside`, pct(sc.hi), pct(aside));
      attachTip(seg, () => h('div', null, h('div', { class: 'tip-value' }, dollars(aside)), h('div', { class: 'tip-label' }, h('i', { class: 'k k-seg seg-aside' }), `Left in the ${acct.kind.toUpperCase()}, ${p.short}`), h('div', { class: 'tip-note' }, accountWords(acct, ctx))));
      bar.appendChild(seg);
      topSeg = seg;
    }
    if (topSeg) topSeg.classList.add('cap');

    // The dashed outline, on up to the worst case.
    const solidTop = sc.hi + aside;
    const ceil = p.scenarios.ceiling.hi;
    const gap = Math.max(0, ceil - solidTop);
    const outline = h('div', { class: 'outline' + (pick && priority === 'protect' ? ' emph' : ''), tabindex: '0', role: 'img', 'aria-label': `${p.name}: worst case ${dollars(ceil)}${p.noCeiling ? ' or more' : ''}` });
    place(outline, `${p.id}:outline`, pct(solidTop), pct(gap));
    attachTip(outline, () =>
      h(
        'div',
        null,
        h('div', { class: 'tip-value' }, dollarsRange(p.scenarios.ceiling) + (p.noCeiling ? '+' : '')),
        h('div', { class: 'tip-label' }, `${p.short}: worst case`),
        h('div', { class: 'tip-note' }, p.noCeiling ? 'every cap reached, plus the charges no cap covers' : 'premiums plus the out-of-pocket cap: the most this plan can cost you in a year'),
        ceil - sc.hi > 0.5 ? h('div', { class: 'tip-note' }, `${dollars(ceil - sc.hi)} above the ${YEAR_WORDS[sKey]}`) : null
      )
    );
    bar.appendChild(outline);

    // The year's total sits just above the stack, inside the outline when there is room (on
    // two lines when it is a range, so it stays within the bar), otherwise above the outline.
    const anchor = solidTop;
    const ranged = sc.hi - sc.lo >= 1;
    const twoLines = ranged || hedge;
    const emphTotal = pick && priority === 'normal';
    const roomy = px(ceil - anchor) >= (twoLines ? 2 : 1) * (emphTotal ? 20 : 17) + (aside ? 16 : 0) + 6;
    const atLeast = () => {
      const el = h('span', { class: 'hedge', tabindex: '0' }, 'at least');
      attachTip(el, () => h('div', null, h('div', { class: 'tip-label' }, `${p.short}: at least`), h('div', { class: 'tip-note' }, 'Someone is at their out-of-pocket cap this year, so their care beyond the cap left no trace. Saying which month they reached it sharpens this.')));
      return el;
    };
    const totalText = (stacked) => {
      const pre = hedge ? [atLeast(), ' '] : [];
      if (!twoLines || !stacked) return [h('b', null, ...pre, dollarsRange(sc))];
      if (ranged) return [h('b', null, ...pre, dollars(sc.lo) + ' to'), h('br'), h('b', null, dollars(sc.hi))];
      return [h('b', null, atLeast()), h('br'), h('b', null, dollars(sc.lo))];
    };
    const total = h('div', { class: 'tot' + (emphTotal ? ' emph' : '') }, totalText(roomy), aside ? h('small', null, `+ ${dollars(aside)} left in ${parts.account.kind.toUpperCase()}`) : null);
    col.appendChild(bar);
    place(total, `${p.id}:tot`, pct(roomy ? anchor : Math.max(ceil, anchor)), null);
    col.appendChild(total);
    cols.appendChild(col);

    const pay = p.paycheck;
    labels.appendChild(
      h(
        'div',
        { class: 'xlabel' + (dim ? ' dim' : '') + (pick ? ' pick' : '') },
        h('h3', null, p.name),
        h(
          'p',
          { class: 'paycheck' + (pick && priority === 'paycheck' ? ' emph' : '') },
          h('b', null, dollars(pay.total)),
          ' a paycheck',
          ctx.view === 'takehome' ? h('small', null, ` (${dollars(pay.gross)} before tax)`) : null,
          pay.election > 0 ? h('small', null, `, ${dollars(pay.grossElection)} of it to the ${pay.electionKind.toUpperCase()}`) : null
        ),
        p.neverCheapest ? h('p', { class: 'tag-never' }, 'not cheapest in any year shown') : null
      )
    );
  });

  // Legend: only what is on screen.
  const key = (cls, text) => h('span', null, h('i', { class: `k ${cls}` }), text);
  const legend = h('div', { class: 'mark-key' });
  for (const [k, name] of SEGMENTS) if (used.has(k)) legend.appendChild(key(`k-seg seg-${k}`, name));
  if (anyOpen) legend.appendChild(key('k-seg seg-open', 'Depends on an open plan question'));
  if (anyAside) legend.appendChild(key('k-seg seg-aside', 'Left in the FSA or HSA after this year\'s care'));
  legend.appendChild(key('k-outline', 'On up to the worst case'));

  return h(
    'div',
    { class: 'stack-chart' },
    legend,
    h('div', { class: 'plot' }, cols, labels),
    h('p', { class: 'axis-title' }, `total for the ${YEAR_WORDS[sKey]}, ${ctx.viewLabel}`)
  );
}

function accountWords(acct, ctx) {
  const name = acct.kind.toUpperCase();
  let s = `${dollars(acct.gross)} set aside in the ${name}`;
  if (ctx.view === 'takehome' && Math.abs(acct.set - acct.gross) > 0.5) s += ` (${dollars(acct.set)} of take-home pay)`;
  if (acct.leftover < 0.5) return s + ". This year's care uses all of it.";
  s += `. This year's care uses ${dollars(acct.used)}, which leaves ${dollars(acct.leftover)}`;
  if (ctx.view === 'takehome' && acct.gross > 0) s += ` (${dollars((acct.leftover * acct.set) / acct.gross)} of take-home pay)`;
  return s + (acct.kind === 'hsa' ? ' in the account, yours to keep. It is not counted in the total.' : ' for other eligible things, such as over-the-counter medicine. It is not counted in the total.');
}

function segTip(p, sKey, key, name, v, ctx) {
  const box = h('div', null, h('div', { class: 'tip-value' }, dollars(v)), h('div', { class: 'tip-label' }, h('i', { class: `k k-seg seg-${key}` }), `${name}, ${p.short}`));
  const about = {
    premium: `${dollars(p.paycheck.premium)} a paycheck, whatever the year brings` + (ctx.view === 'takehome' ? '. Shown after tax' : ''),
    ded: 'what you pay in full before the plan starts sharing costs',
    cc: 'flat copays, and your share of bills once the deductible is met',
    extra: 'out-of-network charges above what the plan recognises, and care it does not cover',
  }[key];
  box.appendChild(h('div', { class: 'tip-note' }, about));
  const acct = p.scenarios[sKey].parts.account;
  if (acct && acct.used > 0.5 && ctx.view === 'takehome' && key !== 'premium') {
    box.appendChild(h('div', { class: 'tip-note' }, `${dollars(acct.used)} of this year's care is paid from the ${acct.kind.toUpperCase()} with untaxed money, so it takes less out of your pay than its face value`));
  }
  const what = { expected: 'the year your answers describe', bad: 'the typical year plus ' + (ctx.seriousLabel || 'one serious event') }[sKey];
  box.appendChild(h('div', { class: 'tip-note' }, `${YEAR_WORDS[sKey]}: ${what}`));
  return box;
}

module.exports = { stackedBars, hideTip };
