'use strict';
// Questionnaire -> household -> scenarios, on the invented demo plans.
const test = require('node:test');
const assert = require('node:assert');
const { validateConfig, getPlan } = require('../src/plans.js');
const { build, defaultAnswers, newPerson } = require('../src/household.js');
const { evaluate, breakEven, yearCost, perPaycheck } = require('../src/outlook.js');

const config = validateConfig(require('../demo/plans.demo.json'));
const near = (got, want, tol = 0.01) => assert.ok(Math.abs(got - want) <= tol, `got ${got}, want ${want}`);
const byId = (out, id) => out.plans.find((p) => p.id === id);

function single(extra) {
  const a = defaultAnswers(config, '2099-12-31');
  a.currentPlan = 'fern';
  Object.assign(a.people[0], { dedMet: 0, oopMet: 0, usage: 'checkups' }, extra);
  return a;
}

test('healthy single person: floor, quiet and expected sit together; ceiling is premium plus cap', () => {
  const hh = build(config, single({ usage: 'counts', counts: { office: 0, therapy: 0, urgent: 0, er: 0 } }));
  assert.deepStrictEqual(hh.problems, []);
  assert.strictEqual(hh.tierId, 'employee');
  const out = evaluate(config, hh, { view: 'raw' });
  const fern = byId(out, 'fern');
  near(fern.scenarios.floor.lo, 140 * 26);
  near(fern.scenarios.expected.lo, 140 * 26);
  near(fern.scenarios.ceiling.lo, 140 * 26 + 1800);
  // With no care, the cheapest premium wins everything but the ceiling.
  assert.strictEqual(byId(out, 'lichen').neverCheapest, false);
});

test('answers scale to a full year from the as-of date', () => {
  const a = single({ usage: 'counts', counts: { office: 3, therapy: 0, urgent: 0, er: 0 }, dedMet: 200, oopMet: 260 });
  a.asOf = '2099-07-02'; // half the year
  const hh = build(config, a);
  const visits = hh.items.filter((it) => /office visits/.test(it.group)).reduce((s, it) => s + it.count, 0);
  near(visits, 6, 0.05);
  const charges = hh.items.filter((it) => it.category === 'ded_coins').reduce((s, it) => s + it.allowed, 0);
  near(charges, 400, 3);
});

test('a one-off is carried over once, not scaled, and left out of the quiet year', () => {
  const a = single({ usage: 'counts', counts: { office: 0, therapy: 0, urgent: 0, er: 0 }, dedMet: 400, oopMet: 400 + 0.15 * 2600, oneOff: 2400 });
  a.asOf = '2099-07-02';
  const hh = build(config, a);
  const oneOff = hh.items.filter((it) => it.oneoff).reduce((s, it) => s + it.allowed, 0);
  const rest = hh.items.filter((it) => !it.oneoff).reduce((s, it) => s + it.allowed, 0);
  near(oneOff, 2400);
  near(rest, 600 * 2, 8); // the other 600 of charges, doubled for the half year
  const out = evaluate(config, hh, { view: 'raw' });
  assert.ok(byId(out, 'fern').scenarios.quiet.lo < byId(out, 'fern').scenarios.expected.lo);
});

test('care that started partway through the year is scaled from when it started', () => {
  const a = single({ usage: 'counts', counts: { office: 0, therapy: 12, urgent: 0, er: 0 }, dedMet: 0, oopMet: 240, shape: 'started', shapeMonth: 10 });
  const hh = build(config, a); // as of year end: 12 sessions in 3 months
  const sessions = hh.items.filter((it) => /therapy/.test(it.group)).reduce((s, it) => s + it.count, 0);
  near(sessions, 48, 0.01);
});

test('someone at the cap with no month given: other plans are marked "at least"', () => {
  const a = single({ usage: 'counts', counts: { office: 0, therapy: 0, urgent: 0, er: 0 }, dedMet: 400, oopMet: 1800 });
  const hh = build(config, a);
  assert.deepStrictEqual(hh.lowerBound, ['p1']);
  const out = evaluate(config, hh, { view: 'raw' });
  assert.strictEqual(byId(out, 'fern').atLeast, false); // capped there too: exact
  assert.strictEqual(byId(out, 'moss').atLeast, true);
  // Saying which month the cap was hit projects the rate forward and removes the hedge.
  a.gates.cap = true;
  a.people[0].capMonth = 6;
  const hh2 = build(config, a);
  assert.deepStrictEqual(hh2.lowerBound, []);
  const sum = (h) => h.items.reduce((s, it) => s + it.allowed, 0);
  near(sum(hh2), 2 * sum(hh), 1);
});

test('inconsistent answers block the result until settled', () => {
  const a = single({ usage: 'counts', counts: { office: 20, therapy: 0, urgent: 0, er: 0 }, dedMet: 0, oopMet: 60 });
  const hh = build(config, a);
  assert.ok(hh.problems.some((p) => p.blocking && p.code === 'copays-exceed'));
  a.people[0].trust = 'dollars';
  assert.deepStrictEqual(build(config, a).problems, []);
});

test('new hire: presets alone, no accumulators asked for', () => {
  const a = defaultAnswers(config, '2099-03-01');
  a.currentPlan = null;
  a.people[0].usage = 'few';
  const hh = build(config, a);
  assert.deepStrictEqual(hh.problems, []);
  assert.ok(hh.items.length > 0);
  assert.ok(hh.assumptions.some((x) => x.id === 'preset-p1'));
});

test('family: tier, credits, surcharge, someone leaving and someone joining', () => {
  const a = single();
  const spouse = Object.assign(newPerson('p2', 'spouse'), { dedMet: 0, oopMet: 0, usage: 'checkups' });
  const kid = Object.assign(newPerson('p3', 'child'), { dedMet: 0, oopMet: 0, usage: 'checkups', nextYear: false });
  const baby = Object.assign(newPerson('p4', 'child'), { thisYear: false, usage: 'few' });
  a.people.push(spouse, kid, baby);
  a.adv.surcharge = true;
  const hh = build(config, a);
  assert.strictEqual(hh.tierId, 'family');
  assert.strictEqual(hh.credit, 2);
  assert.deepStrictEqual(hh.people.map((p) => p.id), ['p1', 'p2', 'p4']);
  const out = evaluate(config, hh, { view: 'raw' });
  near(byId(out, 'moss').premiumYear, 345 * 26 + 60 * 12);
  near(byId(out, 'moss').paycheck.total, 345 + (60 * 12) / 26);
});

test('take-home view: premiums are pre-tax, care is not, FSA and HSA change that', () => {
  const fern = getPlan(config, 'fern');
  const lichen = getPlan(config, 'lichen');
  const hh = { tierId: 'employee', credit: 0, taxRate: 0.3, fsa: 0, hsa: 0, hsaEligible: true, hsaLimit: 4300 };
  near(yearCost(config, fern, hh, 1000, 'raw'), 160 * 26 + 1000);
  near(yearCost(config, fern, hh, 1000, 'takehome'), 160 * 26 * 0.7 + 1000);
  // FSA of 800 against 1000 of care: 800 of it is pre-tax.
  near(yearCost(config, fern, { ...hh, fsa: 800 }, 1000, 'takehome'), 160 * 26 * 0.7 + 1000 - 0.3 * 800);
  // FSA of 2200 against 1000 of care: 640 rolls over, 560 is lost.
  near(yearCost(config, fern, { ...hh, fsa: 2200 }, 1000, 'takehome'), 160 * 26 * 0.7 + 0.7 * (2200 - 640));
  // HSA: the tax saving arrives whatever the year brings.
  near(yearCost(config, lichen, { ...hh, hsa: 2100 }, 0, 'takehome'), 80 * 26 * 0.7 - 0.3 * 2100);
  near(perPaycheck(config, fern, { ...hh, fsa: 1440 }, 'raw').total, 160 + 60);
});

test('HSA-ineligible household: the high-deductible plan is shown without the tax benefit', () => {
  const a = single();
  a.adv.hsa = 2900;
  const eligible = evaluate(config, build(config, a));
  a.gates.hsa = true;
  a.hsa.spouseFsa = true;
  const hh = build(config, a);
  assert.strictEqual(hh.hsaEligible, false);
  const blocked = evaluate(config, hh);
  assert.strictEqual(byId(blocked, 'lichen').hsaBlocked, true);
  near(byId(blocked, 'lichen').scenarios.floor.lo - byId(eligible, 'lichen').scenarios.floor.lo, 0.3 * 2900);
});

test('"never the cheapest": judged on yearly totals, with the paycheck noted separately', () => {
  // Heavy recurring care: the cheap-premium plan loses every judged scenario...
  const a = single({ usage: 'counts', counts: { office: 12, therapy: 40, urgent: 2, er: 0 }, dedMet: 400, oopMet: 1750 });
  const out = evaluate(config, build(config, a), { view: 'raw' });
  const lichen = byId(out, 'lichen');
  assert.strictEqual(lichen.neverCheapest, true);
  assert.strictEqual(lichen.smallestPaycheck, true); // ...while still having the smallest deduction
  assert.ok(out.trades.every((t) => t.more !== 'lichen' && t.less !== 'lichen'), 'trades only between plans still standing');
  const t = out.trades[0];
  assert.strictEqual(t.more, 'fern');
  near(t.perPaycheck, 140 - 105);
  near(t.worstCase, 105 * 26 + 3300 - (140 * 26 + 1800));
});

test('unknown plan facts widen a plan into a range', () => {
  const a = single();
  a.gates.rx = true;
  a.people[0].rx = { rx_generic: { fills: 2, price: 40 } };
  a.people[0].oopMet = 2 * 12 * 8; // the copays those fills cost this year
  const out = evaluate(config, build(config, a), { view: 'raw' });
  const lichen = byId(out, 'lichen');
  assert.strictEqual(lichen.open.length, 1);
  assert.ok(lichen.scenarios.expected.hi > lichen.scenarios.expected.lo);
  assert.strictEqual(byId(out, 'fern').scenarios.expected.hi, byId(out, 'fern').scenarios.expected.lo);
});

test('out-of-network care: the worst case is marked as having no true ceiling', () => {
  const a = single();
  a.gates.oon = true;
  a.people[0].oon = { visits: 24, charge: 200 };
  const hh = build(config, a);
  const out = evaluate(config, hh, { view: 'raw' });
  assert.strictEqual(byId(out, 'fern').noCeiling, true);
  for (const p of out.plans) assert.ok(p.scenarios.ceiling.lo >= p.scenarios.bad.hi - 0.01, 'the worst case is never below the bad year');
  near(byId(out, 'fern').variants[0].expected.uncapped, 24 * 200 * 0.3, 0.5);
});

test('break-even: with no care the cheapest premium wins; with a lot, the low cap does', () => {
  const a = single({ usage: 'counts', counts: { office: 6, therapy: 0, urgent: 0, er: 0 }, dedMet: 400, oopMet: 400 + 120 + 0.15 * 2900 });
  const be = breakEven(config, build(config, a), { view: 'raw' });
  assert.strictEqual(be.cheapestAtZero, 'lichen');
  assert.ok(be.crossings.length >= 1);
  assert.strictEqual(be.series.length, 3);
});

test('leaving mid-year: premiums and care for part of the year', () => {
  const a = single({ usage: 'few' });
  a.currentPlan = null;
  a.events.leaving = { on: true, month: 6 };
  const hh = build(config, a);
  assert.ok(hh.items.every((it) => it.month <= 6));
  near(byId(evaluate(config, hh, { view: 'raw' }), 'fern').premiumYear, 140 * 13);
});
