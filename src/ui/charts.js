'use strict';
// The two charts: range bars (the front) and break-even (secondary).
// Marks carry the plan colour; all text stays in text colours.

const { h, dollars, dollarsRange } = require('./dom.js');
const { SCENARIO_LABELS } = require('../outlook.js');

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

// ---- range bars ----------------------------------------------------------------------------
// out: result of outlook.evaluate.  ctx: { priority, canAbsorb, viewLabel }
function rangeBars(out, ctx) {
  const plans = out.plans;
  const lo = Math.min(...plans.map((p) => p.scenarios.floor.lo));
  const hi = Math.max(...plans.map((p) => Math.max(p.scenarios.ceiling.hi, p.scenarios.bad.hi)));
  const pad = (hi - lo) * 0.03 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const x = (v) => ((v - min) / (max - min)) * 100;
  const priority = ctx.priority;

  const root = h('div', { class: 'bars' });
  root.appendChild(
    h(
      'div',
      { class: 'mark-key', 'aria-hidden': 'true' },
      h('span', null, h('i', { class: 'k k-track' }), 'premiums only to worst case'),
      h('span', null, h('i', { class: 'k k-quiet' }), 'quiet year'),
      h('span', null, h('i', { class: 'k k-expected' }), 'expected'),
      h('span', null, h('i', { class: 'k k-bad' }), 'bad year')
    )
  );

  const ticks = niceTicks(min, max, 5);
  const grid = () => h('div', { class: 'gridlines', 'aria-hidden': 'true' }, ticks.map((t) => h('i', { style: { left: x(t) + '%' } })));

  plans.forEach((p, i) => {
    const dim = p.neverCheapest && priority !== 'paycheck';
    const row = h('section', { class: 'plan-row' + (dim ? ' dim' : ''), style: { '--c': `var(--s${(i % 6) + 1})` }, 'aria-label': p.name });
    const s = p.scenarios;

    const pay = p.paycheck;
    const payEl = h(
      'span',
      { class: 'paycheck' + (priority === 'paycheck' ? ' emph' : '') },
      h('b', null, dollars(pay.total)),
      ctx.view === 'takehome' ? ' less take-home per paycheck' : ' per paycheck',
      h(
        'small',
        null,
        ' (' +
          (ctx.view === 'takehome' ? `${dollars(pay.gross)} before tax` : 'the premium') +
          (pay.election > 0 ? `, including ${dollars(pay.grossElection)} to the ${pay.electionKind.toUpperCase()}` : '') +
          ')'
      )
    );
    row.appendChild(h('header', { class: 'plan-head' }, h('span', { class: 'swatch' }), h('h3', null, p.name), payEl));

    const wrap = h('div', { class: 'track-wrap' });
    wrap.appendChild(grid());
    const track = h('div', {
      class: 'track' + (priority === 'protect' ? ' cap-emph' : ''),
      style: { left: x(s.floor.lo) + '%', width: Math.max(0.5, x(s.ceiling.hi) - x(s.floor.lo)) + '%' },
    });
    wrap.appendChild(track);

    const mark = (key, cls) => {
      const r = s[key];
      const ranged = r.hi - r.lo >= 1;
      const el = h('div', {
        class: `mark ${cls}` + (ranged ? ' ranged' : '') + (key === 'expected' && priority !== 'protect' && priority !== 'paycheck' ? ' emph' : ''),
        tabindex: '0',
        role: 'img',
        'aria-label': `${p.name}, ${SCENARIO_LABELS[key]}: ${p.atLeast && key !== 'bad' ? 'at least ' : ''}${dollarsRange(r)} a year`,
        style: ranged ? { left: x(r.lo) + '%', width: `max(12px, ${x(r.hi) - x(r.lo)}%)` } : { left: x(r.lo) + '%' },
      });
      attachTip(el, () => tipFor(p, key, ctx));
      return el;
    };
    wrap.appendChild(mark('quiet', 'm-quiet'));
    wrap.appendChild(mark('bad', 'm-bad'));
    wrap.appendChild(mark('expected', 'm-expected'));
    // Hit areas for the two ends.
    for (const key of ['floor', 'ceiling']) {
      const el = h('div', { class: 'end-hit', tabindex: '0', role: 'img', 'aria-label': `${p.name}, ${SCENARIO_LABELS[key]}: ${dollarsRange(s[key])} a year`, style: { left: x(key === 'floor' ? s.floor.lo : s.ceiling.hi) + '%' } });
      attachTip(el, () => tipFor(p, key, ctx));
      wrap.appendChild(el);
    }

    const expMid = (s.expected.lo + s.expected.hi) / 2;
    const top = h(
      'div',
      { class: 'lab-top' + (priority === 'protect' || priority === 'paycheck' ? '' : ' emph'), style: { left: x(expMid) + '%' }, 'data-fit': 'center' },
      'expected ',
      h('b', null, (p.atLeast ? 'at least ' : '') + dollarsRange(s.expected))
    );
    wrap.appendChild(top);
    row.appendChild(wrap);

    const ends = h(
      'div',
      { class: 'ends' },
      h('span', { class: 'end-lo', style: { left: x(s.floor.lo) + '%' } }, h('b', null, dollarsRange(s.floor)), ' premiums only'),
      h(
        'span',
        { class: 'end-hi' + (priority === 'protect' ? ' emph' : ''), style: { left: x(s.ceiling.hi) + '%' } },
        'worst case ',
        h('b', null, dollarsRange(s.ceiling) + (p.noCeiling ? '+' : ''))
      )
    );
    row.appendChild(ends);

    const flags = [];
    if (p.neverCheapest) {
      flags.push(h('p', { class: 'flag flag-never' }, 'Never the cheapest over a year for your answers.' + (p.smallestPaycheck ? ' It does have the smallest paycheck deduction.' : '')));
    }
    if (priority === 'paycheck' && ctx.canAbsorb === false && p.smallestPaycheck && plans.length > 1) {
      flags.push(
        h(
          'p',
          { class: 'flag flag-warn' },
          h('span', { class: 'ico', 'aria-hidden': 'true' }, '!'),
          `Smallest deduction, and the largest possible early-year bill: you could owe up to ${dollars(p.deductibleOne)}${p.deductible > p.deductibleOne ? ` for one person (${dollars(p.deductible)} across the family)` : ''} before this plan pays for most care. You said a bill that size would be hard to absorb.`
        )
      );
    }
    if (p.atLeast) flags.push(h('p', { class: 'flag' }, 'Shown as "at least": someone is at their out-of-pocket cap this year, so their care beyond the cap left no trace. Saying which month they hit it sharpens this.'));
    if (p.noCeiling) flags.push(h('p', { class: 'flag' }, 'The worst case counts both caps and the extras from the care you described, but there is no true ceiling: charges the plan does not recognise are yours and count toward nothing, so more of that care means more cost.'));
    if (p.hsaBlocked) flags.push(h('p', { class: 'flag' }, 'Shown without the HSA tax benefit, because you are not eligible to contribute.'));
    if (p.open.length) flags.push(h('p', { class: 'flag' }, 'A range, not a point, because ' + p.open.map((u) => u.text).join('; and ') + '.'));
    if (flags.length) row.appendChild(h('div', { class: 'flags' }, flags));
    root.appendChild(row);
  });

  // Axis
  const axis = h('div', { class: 'axis', 'aria-hidden': 'true' });
  const compact = ticks[ticks.length - 1] >= 10000;
  for (const t of ticks) axis.appendChild(h('span', { style: { left: x(t) + '%' } }, compact ? '$' + (t / 1000).toLocaleString('en-US') + 'K' : dollars(t)));
  root.appendChild(h('div', { class: 'axis-wrap' }, axis, h('div', { class: 'axis-title' }, `total for the year, ${ctx.viewLabel}`)));
  return root;
}

function tipFor(p, key, ctx) {
  const s = p.scenarios[key];
  const box = h('div', null);
  box.appendChild(h('div', { class: 'tip-value' }, (p.atLeast && (key === 'quiet' || key === 'expected') ? 'at least ' : '') + dollarsRange(s)));
  box.appendChild(h('div', { class: 'tip-label' }, h('i', { class: 'linekey' }), `${p.short}: ${SCENARIO_LABELS[key]}`));
  const care = s.care;
  const what = { floor: 'no care beyond free preventive visits', quiet: 'recurring care only, no one-offs', expected: 'the year your answers describe', bad: 'the expected year plus ' + (ctx.seriousLabel || 'one serious event'), ceiling: p.noCeiling ? 'every cap reached, plus the charges no cap covers' : 'the out-of-pocket cap reached' }[key];
  box.appendChild(h('div', { class: 'tip-note' }, what));
  box.appendChild(h('div', { class: 'tip-note' }, `care ${dollarsRange(care)} + premiums ${dollars(p.premiumYear)}` + (ctx.view === 'takehome' ? ', then adjusted for tax' : '')));
  return box;
}

// Keep labels inside their row and stop the two end labels from running into each other.
function fitLabels(root) {
  for (const wrap of root.querySelectorAll('.track-wrap')) {
    const w = wrap.getBoundingClientRect();
    const lab = wrap.querySelector('.lab-top');
    if (lab) {
      lab.style.transform = 'translateX(-50%)';
      const r = lab.getBoundingClientRect();
      let shift = 0;
      if (r.left < w.left) shift = w.left - r.left;
      else if (r.right > w.right) shift = w.right - r.right;
      lab.style.transform = `translateX(calc(-50% + ${shift}px))`;
    }
  }
  for (const ends of root.querySelectorAll('.ends')) {
    ends.classList.remove('stack');
    const w = ends.getBoundingClientRect();
    const a = ends.querySelector('.end-lo');
    const b = ends.querySelector('.end-hi');
    a.style.transform = '';
    b.style.transform = 'translateX(-100%)';
    let ra = a.getBoundingClientRect();
    let rb = b.getBoundingClientRect();
    if (ra.right > w.right) a.style.transform = `translateX(${w.right - ra.right}px)`;
    if (rb.left < w.left) b.style.transform = `translateX(calc(-100% + ${w.left - rb.left}px))`;
    ra = a.getBoundingClientRect();
    rb = b.getBoundingClientRect();
    if (ra.right + 10 > rb.left) ends.classList.add('stack');
  }
}

// ---- break-even ----------------------------------------------------------------------------
function breakEvenChart(be, out, ctx) {
  const W = Math.max(320, ctx.width || 560);
  const H = 250;
  const m = { l: 50, r: 58, t: 16, b: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const all = be.series.flatMap((s) => s.points);
  const yMin = Math.min(...all.map((p) => p.lo));
  const yMax = Math.max(...all.map((p) => p.hi));
  const ticks = niceTicks(yMin, yMax, 4);
  const y0 = Math.min(yMin, ticks[0]);
  const y1 = Math.max(yMax, ticks[ticks.length - 1]);
  const X = (k) => m.l + (k / be.maxK) * iw;
  const Y = (v) => m.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const compact = y1 >= 10000;
  const tickLabel = (t) => (compact ? '$' + (t / 1000).toLocaleString('en-US') + 'K' : dollars(t));

  const svg = h('svg', { class: 'be', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Total yearly cost on each plan as the amount of care goes from none to three times the estimate' });
  for (const t of ticks) {
    svg.appendChild(h('line', { class: 'grid', x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t) }));
    svg.appendChild(h('text', { class: 'tick', x: m.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, tickLabel(t)));
  }
  const xt = [
    [0, 'no care'],
    [0.5, 'half'],
    [1, 'your estimate'],
    [2, 'double'],
    [3, 'triple'],
  ].filter(([k]) => k <= be.maxK);
  for (const [k, label] of xt) {
    svg.appendChild(h('text', { class: 'tick' + (k === 1 ? ' strong' : ''), x: X(k), y: m.t + ih + 18, 'text-anchor': k === 0 ? 'start' : 'middle' }, label));
  }
  svg.appendChild(h('text', { class: 'axis-title', x: m.l + iw / 2, y: H - 4, 'text-anchor': 'middle' }, 'how much care you end up using'));
  svg.appendChild(h('line', { class: 'here', x1: X(1), x2: X(1), y1: m.t, y2: m.t + ih }));

  const dimmed = new Set(out.plans.filter((p) => p.neverCheapest && ctx.priority !== 'paycheck').map((p) => p.id));
  const ends = [];
  be.series.forEach((s, i) => {
    const color = `var(--s${(i % 6) + 1})`;
    const cls = dimmed.has(s.id) ? ' dim' : '';
    if (s.points.some((p) => p.hi - p.lo > 1)) {
      const up = s.points.map((p) => `${X(p.k)},${Y(p.hi)}`);
      const down = s.points.map((p) => `${X(p.k)},${Y(p.lo)}`).reverse();
      svg.appendChild(h('polygon', { class: 'band' + cls, points: up.concat(down).join(' '), style: { fill: color } }));
    }
    svg.appendChild(h('polyline', { class: 'line' + cls, points: s.points.map((p) => `${X(p.k)},${Y(p.mid)}`).join(' '), style: { stroke: color } }));
    const here = s.points.reduce((a, b) => (Math.abs(b.k - 1) < Math.abs(a.k - 1) ? b : a));
    svg.appendChild(h('circle', { class: 'dot' + cls, cx: X(here.k), cy: Y(here.mid), r: 4.5, style: { fill: color } }));
    const last = s.points[s.points.length - 1];
    ends.push({ y: Y(last.mid), label: s.short, color });
  });
  // End labels only where they do not collide; the legend carries the rest.
  ends.sort((a, b) => a.y - b.y);
  ends.forEach((e, i) => {
    const clash = (i > 0 && e.y - ends[i - 1].y < 13) || (i < ends.length - 1 && ends[i + 1].y - e.y < 13);
    if (!clash) svg.appendChild(h('text', { class: 'endlabel', x: m.l + iw + 8, y: e.y + 4 }, e.label));
  });

  // Hover: a crosshair that snaps to the nearest step, one tooltip listing every plan.
  const cross = h('line', { class: 'cross', y1: m.t, y2: m.t + ih, x1: 0, x2: 0, visibility: 'hidden' });
  svg.appendChild(cross);
  const hit = h('rect', { class: 'hit', x: m.l, y: m.t, width: iw, height: ih, tabindex: '0', 'aria-label': 'Break-even chart. Use left and right arrow keys to read values.' });
  let idx = be.ks.findIndex((k) => k >= 1);
  const show = (i) => {
    idx = Math.max(0, Math.min(be.ks.length - 1, i));
    const k = be.ks[idx];
    cross.setAttribute('x1', X(k));
    cross.setAttribute('x2', X(k));
    cross.setAttribute('visibility', 'visible');
    const box = h('div', null, h('div', { class: 'tip-note' }, k === 0 ? 'no care at all' : `${k.toFixed(2).replace(/\.?0+$/, '')} times your estimate`));
    const rows = be.series
      .map((s, si) => ({ s, si, p: s.points[idx] }))
      .sort((a, b) => a.p.mid - b.p.mid);
    for (const { s, si, p } of rows) {
      box.appendChild(h('div', { class: 'tip-row' }, h('i', { class: 'linekey', style: { background: `var(--s${(si % 6) + 1})` } }), h('b', null, dollarsRange(p)), ' ', s.short));
    }
    const r = svg.getBoundingClientRect();
    showTip(box, r.left + (X(k) / W) * r.width, r.top + m.t);
  };
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const k = (((e.clientX - r.left) / r.width) * W - m.l) / iw;
    show(Math.round(k * (be.ks.length - 1)));
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    hideTip();
  });
  hit.addEventListener('focus', () => show(idx));
  hit.addEventListener('blur', () => {
    cross.setAttribute('visibility', 'hidden');
    hideTip();
  });
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key === 'ArrowRight') show(idx + 1);
    else return;
    e.preventDefault();
  });
  svg.appendChild(hit);

  const legend = h(
    'div',
    { class: 'legend' },
    be.series.map((s, i) => h('span', null, h('i', { class: 'linekey', style: { background: `var(--s${(i % 6) + 1})` } }), s.name))
  );
  return h('div', { class: 'be-wrap' }, legend, svg);
}

// In words: how far the estimate would have to be off before the cheapest plan changes.
function breakEvenSentence(be, out) {
  const name = (id) => (out.plans.find((p) => p.id === id) || {}).short || id;
  const best = name(be.cheapestAtEstimate);
  if (!be.crossings.length) return `${best} is the cheapest at every level of care from none to ${be.maxK} times your estimate.`;
  const below = be.crossings.filter((c) => c.k <= 1).pop();
  const above = be.crossings.find((c) => c.k > 1);
  const pct = (k) => Math.round(Math.abs(k - 1) * 100);
  const bits = [];
  if (below) bits.push(below.k < 0.04 ? `${name(below.from)} only wins with almost no care at all` : `if you used ${pct(below.k)}% less care than estimated, ${name(below.from)} would be cheaper`);
  if (above) bits.push(`if you used ${above.k >= 2 ? above.k.toFixed(1).replace(/\.0$/, '') + ' times the care' : pct(above.k) + '% more care than'} estimated, ${name(above.to)} would be cheaper`);
  let s = `At your estimate ${best} is the cheapest. ` + bits.join('; ') + '.';
  return s.replace(/\. ([a-z])/, (m0, c) => '. ' + c.toUpperCase());
}

module.exports = { rangeBars, fitLabels, breakEvenChart, breakEvenSentence, hideTip };
