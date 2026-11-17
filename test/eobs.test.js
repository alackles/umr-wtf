'use strict';
// The made-up EOB set is the answer key other agents are marked against, so it has to agree
// with itself: what the EOBs print, what the answer table says, and what the engine charges.
const test = require('node:test');
const assert = require('node:assert');
const { makeSet } = require('../demo/make-eobs.js');
const { score } = require('../demo/score-table.js');
const { parseTable } = require('../src/importer.js');
const { validateConfig } = require('../src/plans.js');
const { replay } = require('../src/engine.js');

const config = validateConfig(require('../demo/plans.demo.json'));
const set = makeSet(config);
const money = (s) => Number(s.replace(/[$,]/g, ''));

test('every made-up EOB adds up: its rows to its totals, and its totals to what is owed', () => {
  assert.ok(set.eobs.length >= 30);
  for (const e of set.eobs) {
    const lines = e.text.split('\n');
    const head = lines.findIndex((l) => l.startsWith('Services you received'));
    const end = lines.findIndex((l) => l.startsWith('Totals'));
    assert.ok(head > 0 && end > head, e.name);
    const cells = (l) => l.match(/\$[\d,]+\.\d\d/g).map(money);
    const totals = cells(lines[end]);
    const rows = lines.slice(head + 1, end).map(cells);
    for (let k = 0; k < totals.length; k++) {
      const sum = rows.reduce((s, r) => s + r[k], 0);
      assert.ok(Math.abs(sum - totals[k]) < 0.005, `${e.name}: column ${k} adds to ${sum}, totals row says ${totals[k]}`);
    }
    // billed, discount, not allowed, plan paid, copay, deductible, coinsurance, not covered, owe
    for (const r of rows) assert.ok(Math.abs(r[4] + r[5] + r[6] + r[7] - r[8]) < 0.005, `${e.name}: a row's charges do not add to what is owed`);
  }
});

test('the answer table reads through the importer and replays to what the EOBs say was owed', () => {
  const { items, errors } = parseTable(set.answerCsv);
  assert.deepStrictEqual(errors, []);
  const res = replay(items, set.plan, { family: true });
  const printed = Object.values(set.summary.owed).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(res.total - printed) < 0.5, `replay ${res.total} vs EOBs ${printed}`);
  assert.ok(Object.values(res.capped).some(Boolean), 'someone reaches their out-of-pocket limit');
  for (const cat of ['office', 'urgent', 'preventive', 'ded_coins', 'er_facility', 'er_physician', 'not_covered']) assert.ok(items.some((it) => it.category === cat), cat);
  assert.ok(items.some((it) => it.network === 'out') && items.some((it) => it.count === 0));
});

test('the scorer: the answer scores clean against itself, and a wrong category shows up in the plan costs', () => {
  const answer = parseTable(set.answerCsv).items;
  const clean = score(config, answer, answer);
  assert.strictEqual(clean.rows.right, answer.length);
  assert.ok(clean.plans.every((p) => Math.abs(p.got - p.answer) < 1e-9));
  const spoiled = answer.map((it) => (it.category === 'ded_coins' ? Object.assign({}, it, { category: 'preventive' }) : it));
  const s = score(config, answer, spoiled);
  assert.ok(s.wrong.length > 0 && s.rows.right < answer.length);
  assert.ok(s.plans.some((p) => p.answer - p.got > 100));
});
