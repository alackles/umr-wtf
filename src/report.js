'use strict';
// The page's results as plain text, for pasting somewhere else: into a chat with an agent
// that has worked the plans out for itself, so the two sets of numbers can be compared.
// Raw dollars come first because they are what another calculation will have produced.

const { evaluate } = require('./outlook.js');

const usd = (n) => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const span = (r) => (Math.abs(r.hi - r.lo) < 1 ? usd(r.lo) : `${usd(r.lo)} to ${usd(r.hi)}`);
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function resultsText(config, hh) {
  const raw = evaluate(config, hh, { view: 'raw' });
  const net = evaluate(config, hh, { view: 'takehome' });
  const out = [];
  out.push(`Results from the plan comparison tool, plan year ${config.planYear}`);
  out.push(`Coverage: ${hh.tierLabel}. Every figure is for a full year.`);
  out.push('');
  out.push('RAW DOLLARS (no tax effect)');
  for (const p of raw.plans) {
    const s = p.scenarios;
    out.push('');
    out.push(p.name);
    out.push(`  Premiums: ${span(s.floor)} (${usd(p.paycheck.total)} from each paycheck, with any FSA or HSA contribution)`);
    out.push(`  Typical year: ${span(s.expected.care)} for care, ${span(s.expected)} in all`);
    out.push(`  Catastrophic year: ${span(s.bad.care)} for care, ${span(s.bad)} in all`);
    out.push(`  Worst case: ${span(s.ceiling)} in all${p.noCeiling ? ' (not a true ceiling: some of this care has no cap)' : ''}`);
    for (const u of p.open) out.push(`  A range here means: ${u.text}.`);
    if (p.atLeast) out.push('  The care figures are "at least": someone reached their out-of-pocket cap this year, so their care beyond it is not known.');
    if (p.hsaBlocked) out.push('  Shown without the HSA tax benefit.');
  }
  out.push('');
  out.push(`TAKE-HOME PAY (a ${Math.round(hh.taxRate * 100)}% tax rate; premiums come out before tax, care does not unless it goes through an FSA or HSA)`);
  out.push('');
  for (const p of net.plans) {
    const s = p.scenarios;
    out.push(`${p.name}: typical year ${span(s.expected)}, catastrophic year ${span(s.bad)}, worst case ${span(s.ceiling)}, ${usd(p.paycheck.total)} a paycheck`);
  }
  out.push('');
  out.push('ASSUMING');
  out.push('');
  for (const a of hh.assumptions) out.push(`- ${upper(a.text)}`);
  if (hh.notes.length) {
    out.push('');
    out.push('NOTES');
    out.push('');
    for (const n of hh.notes) out.push(`- ${n.text}`);
  }
  return out.join('\n') + '\n';
}

module.exports = { resultsText };
