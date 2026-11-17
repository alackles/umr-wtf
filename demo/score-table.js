#!/usr/bin/env node
'use strict';
// Compares a table an agent produced with the right answer for the made-up EOB set.
//
//   node demo/score-table.js <agent-table.csv> [--answer dist/eobs/answer.csv] [--config <plans.json>]
//
// Rows are matched on person, date and allowed amount (to the cent); a matched row is then
// right or wrong on category, network and count. Because an agent may split or join rows in
// ways that are still correct, the totals by category and the cost of the year under each
// plan are compared as well: those are what the page's result depends on.

const fs = require('node:fs');
const path = require('node:path');
const { parseTable } = require('../src/importer.js');
const { validateConfig } = require('../src/plans.js');
const { replay } = require('../src/engine.js');

const usd = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function score(config, answer, candidate) {
  const key = (it) => `${String(it.person).trim().toLowerCase()}|${it.date || it.month}|${Math.round(it.allowed * 100)}`;
  const pool = new Map();
  for (const it of candidate) {
    const k = key(it);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(it);
  }
  const missing = [];
  const wrong = [];
  let matched = 0;
  for (const want of answer) {
    const got = (pool.get(key(want)) || []).shift();
    if (!got) {
      missing.push(want);
      continue;
    }
    matched++;
    const cnt = (it) => (it.count == null ? 1 : it.count);
    const diffs = [];
    if (got.category !== want.category) diffs.push(`category ${got.category}, should be ${want.category}`);
    if ((got.network || 'in') !== (want.network || 'in')) diffs.push(`network ${got.network || 'in'}, should be ${want.network || 'in'}`);
    if (cnt(got) !== cnt(want)) diffs.push(`count ${cnt(got)}, should be ${cnt(want)}`);
    if (diffs.length) wrong.push({ want, diffs });
  }
  const extra = [...pool.values()].flat();
  const byCategory = (items) => {
    const m = {};
    for (const it of items) m[it.category] = (m[it.category] || 0) + it.allowed;
    return m;
  };
  const a = byCategory(answer);
  const b = byCategory(candidate);
  const categories = [...new Set(Object.keys(a).concat(Object.keys(b)))].sort().map((cat) => ({ cat, answer: a[cat] || 0, got: b[cat] || 0 }));
  const plans = config.plans.map((plan) => {
    const run = (items) => replay(items, plan, { family: true }).memberTotal;
    return { name: plan.name, answer: run(answer), got: run(candidate) };
  });
  return { rows: { answer: answer.length, got: candidate.length, matched, right: matched - wrong.length }, missing, extra, wrong, categories, plans };
}

function report(s) {
  const out = [];
  const row = (it) => `${it.person} ${it.date || 'month ' + it.month} ${it.category} ${usd(it.allowed)}`;
  out.push(`Rows: the answer has ${s.rows.answer}, the table has ${s.rows.got}. ${s.rows.matched} match on person, date and amount; ${s.rows.right} of those are also right on category, network and count.`);
  if (s.wrong.length) out.push('', 'Matched but wrong:', ...s.wrong.map((w) => `  ${row(w.want)}: ${w.diffs.join('; ')}`));
  if (s.missing.length) out.push('', 'In the answer, not found in the table:', ...s.missing.map((it) => `  ${row(it)}`));
  if (s.extra.length) out.push('', 'In the table, not in the answer:', ...s.extra.map((it) => `  ${row(it)}`));
  out.push('', 'Allowed amounts by category (table, answer):');
  for (const c of s.categories) out.push(`  ${c.cat.padEnd(16)}${usd(c.got).padStart(12)}${usd(c.answer).padStart(12)}${Math.abs(c.got - c.answer) > 0.005 ? '   differs by ' + usd(c.got - c.answer) : ''}`);
  out.push('', 'What the year\'s care would cost on each plan, as it happened (table, answer):');
  for (const p of s.plans) out.push(`  ${p.name.padEnd(28)}${usd(p.got).padStart(12)}${usd(p.answer).padStart(12)}${Math.abs(p.got - p.answer) > 0.5 ? '   differs by ' + usd(p.got - p.answer) : ''}`);
  return out.join('\n') + '\n';
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const root = path.join(__dirname, '..');
  if (!args[0] || args[0].startsWith('--')) {
    console.error('usage: node demo/score-table.js <agent-table.csv> [--answer dist/eobs/answer.csv] [--config <plans.json>]');
    process.exit(1);
  }
  const config = validateConfig(JSON.parse(fs.readFileSync(path.resolve(arg('--config', path.join(root, 'demo', 'plans.demo.json'))), 'utf8')));
  const read = (file) => {
    const res = parseTable(fs.readFileSync(path.resolve(file), 'utf8'));
    if (res.errors.length) {
      console.error(`${file} does not read as a table:\n  ${res.errors.slice(0, 12).join('\n  ')}`);
      process.exit(1);
    }
    return res.items;
  };
  process.stdout.write(report(score(config, read(arg('--answer', path.join(root, 'dist', 'eobs', 'answer.csv'))), read(args[0]))));
}

module.exports = { score, report };
