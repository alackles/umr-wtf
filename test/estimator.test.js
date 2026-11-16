'use strict';
// The accumulator maths: the part that can be quietly wrong.
// Method: invent a year of care, replay it under a plan to get the accumulators a person
// would see, then check the estimator recovers the charges from those accumulators alone.
const test = require('node:test');
const assert = require('node:assert');
const { replay } = require('../src/engine.js');
const { backOut, monthsElapsed } = require('../src/estimator.js');
const { validateConfig, getPlan } = require('../src/plans.js');

const config = validateConfig(require('../demo/plans.demo.json'));
const fern = getPlan(config, 'fern');
const moss = getPlan(config, 'moss');
const lichen = getPlan(config, 'lichen');
const T = config.typicalAllowed;
const near = (got, want, tol = 0.01) => assert.ok(Math.abs(got - want) <= tol, `got ${got}, want ${want}`);

// Build a year for one person, and the usage list they would report for it.
function year({ office = 0, urgent = 0, er = 0, charges = 0, person = 'a' }) {
  const items = [];
  for (let i = 0; i < office; i++) items.push({ person, month: 1 + (i % 12), category: 'office', allowed: T.office });
  for (let i = 0; i < urgent; i++) items.push({ person, month: 2 + i, category: 'urgent', allowed: T.urgent });
  for (let i = 0; i < er; i++) {
    items.push({ person, month: 5, category: 'er_facility', allowed: T.er_facility });
    items.push({ person, month: 5, category: 'er_physician', allowed: T.er_physician });
  }
  if (charges) items.push({ person, month: 6, category: 'ded_coins', allowed: charges });
  const usage = [
    { category: 'office', count: office, allowedEach: T.office },
    { category: 'urgent', count: urgent, allowedEach: T.urgent },
    { category: 'er_facility', count: er, allowedEach: T.er_facility },
    { category: 'er_physician', count: er, allowedEach: T.er_physician },
  ];
  return { items, usage };
}

function accumulators(items, plan, family, person = 'a') {
  const r = replay(items, plan, { family });
  return { dedMet: r.acc.in.ded[person] || 0, oopMet: r.acc.in.oop[person] || 0, result: r };
}

test('recovers charges below the deductible', () => {
  const { items, usage } = year({ office: 3, charges: 250 });
  const acc = accumulators(items, fern, false);
  const est = backOut({ plan: fern, family: false, usage, ...acc });
  near(est.residual, 250);
  near(est.copays, 60);
  assert.deepStrictEqual(est.problems, []);
});

test('recovers charges above the deductible', () => {
  for (const plan of [fern, moss]) {
    const { items, usage } = year({ office: 6, urgent: 1, charges: 4200 });
    const acc = accumulators(items, plan, false);
    const est = backOut({ plan, family: false, usage, ...acc });
    near(est.residual, 4200);
  }
});

test('an emergency room visit is taken out before dividing by the coinsurance share', () => {
  const { items, usage } = year({ office: 2, er: 1, charges: 2500 });
  const acc = accumulators(items, fern, false);
  const est = backOut({ plan: fern, family: false, usage, ...acc });
  near(est.residual, 2500);
});

test('family deductible binding: a person below their own deductible still paid coinsurance', () => {
  const a = year({ charges: 600, person: 'a' });
  const b = year({ charges: 600, person: 'b' });
  const c = year({ office: 2, charges: 1300, person: 'c' });
  const items = [...a.items, ...b.items, ...c.items.map((it) => ({ ...it, month: 9 }))];
  const acc = accumulators(items, fern, true, 'c');
  near(acc.dedMet, 0);
  const est = backOut({ plan: fern, family: true, usage: c.usage, familyDedMet: true, ...acc });
  near(est.residual, 1300);
  // Without knowing the family deductible was met, the same dollars cannot be coinsurance.
  const blind = backOut({ plan: fern, family: true, usage: c.usage, familyDedMet: false, ...acc });
  near(blind.residual, 0);
  near(blind.extraCopays, 195);
});

test('a plan that sends visits to the deductible: visits are part of the charges', () => {
  const { items, usage } = year({ office: 5, charges: 3100 });
  const acc = accumulators(items, lichen, false);
  const est = backOut({ plan: lichen, family: false, usage, ...acc });
  near(est.charges, 3100 + 5 * T.office);
  near(est.residual, 3100);
  near(est.copays, 0);
});

test('inconsistent inputs are reported, and settled only when told how', () => {
  // Ten visits listed, but only two copays' worth of dollars beyond the deductible.
  const usage = [{ category: 'office', count: 10, allowedEach: T.office }];
  const base = { plan: fern, family: false, usage, dedMet: 0, oopMet: 40 };
  const est = backOut(base);
  assert.strictEqual(est.problems.length, 1);
  assert.strictEqual(est.problems[0].code, 'copays-exceed');
  assert.strictEqual(est.problems[0].blocking, true);
  const dollars = backOut({ ...base, trust: 'dollars' });
  assert.deepStrictEqual(dollars.problems, []);
  near(dollars.usageScale, 0.2);
  const counts = backOut({ ...base, trust: 'counts' });
  assert.deepStrictEqual(counts.problems, []);
  near(counts.usageScale, 1);
});

test('impossible accumulators are blocked', () => {
  const code = (i) => backOut({ plan: fern, family: false, usage: [], ...i }).problems.map((p) => p.code);
  assert.deepStrictEqual(code({ dedMet: 500, oopMet: 600 }), ['ded-over']);
  assert.deepStrictEqual(code({ dedMet: 400, oopMet: 5000 }), ['oop-over']);
  assert.deepStrictEqual(code({ dedMet: 400, oopMet: 300 }), ['oop-under-ded']);
});

test('at the cap: a lower bound, and listed visits beyond the dollars are not a contradiction', () => {
  const { items, usage } = year({ office: 30, charges: 50000 });
  const acc = accumulators(items, fern, false);
  near(acc.oopMet, 1800);
  const est = backOut({ plan: fern, family: false, usage, censored: true, paidShare: null, ...acc });
  assert.deepStrictEqual(est.problems, []);
  assert.ok(est.residual < 50000, 'only a lower bound can be recovered');
  assert.ok(est.residual >= 400, 'and it is at least the deductible');
});

test('months elapsed', () => {
  near(monthsElapsed('2099-12-31'), 12);
  near(monthsElapsed('2099-07-02'), 6, 0.05);
  assert.strictEqual(monthsElapsed('2099-02-30'), null);
  assert.strictEqual(monthsElapsed('soon'), null);
});
