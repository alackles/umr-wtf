'use strict';
// Questionnaire -> household -> scenarios, on the invented demo plans.
const test = require('node:test');
const assert = require('node:assert');
const { validateConfig, getPlan } = require('../src/plans.js');
const { build, defaultAnswers, newPerson } = require('../src/household.js');
const { evaluate, sensitivity, sensitivitySentence, yearCost, perPaycheck, breakdown } = require('../src/outlook.js');

const config = validateConfig(require('../demo/plans.demo.json'));
const near = (got, want, tol = 0.01) => assert.ok(Math.abs(got - want) <= tol, `got ${got}, want ${want}`);
const byId = (out, id) => out.plans.find((p) => p.id === id);

function single(extra) {
  const a = defaultAnswers(config, '2099-12-31');
  a.currentPlan = 'fern';
  Object.assign(a.people[0], { dedMet: 0, oopMet: 0, usage: 'checkups' }, extra);
  return a;
}

test('healthy single person: floor and typical year sit together; ceiling is premium plus cap', () => {
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

test('regular care already under way explains this year\'s dollars instead of being counted twice', () => {
  // An infusion billed 500, 12 times a year, all through the deductible: 400 deductible + 15% of the other 5600.
  const inf = { id: 'r1', name: 'infusion', times: 12, cost: 500, since: 'year' };
  const a = single({ usage: 'counts', counts: { office: 0, therapy: 0, urgent: 0, er: 0 }, dedMet: 400, oopMet: 400 + 0.15 * 5600, regular: [inf] });
  a.gates.regular = true;
  const hh = build(config, a);
  assert.deepStrictEqual(hh.problems, []);
  const sum = (h, re) => h.items.filter((it) => re.test(it.group)).reduce((s, it) => s + it.allowed, 0);
  near(sum(hh, /infusion/), 12 * 500, 0.5);
  near(sum(hh, /other care/), 0, 1); // nothing left over to scale up and add again
  // The same care starting next year leaves this year's reading alone and adds a full year.
  const b = single({ usage: 'counts', counts: { office: 0, therapy: 0, urgent: 0, er: 0 }, regular: [Object.assign({}, inf, { since: 'next' })] });
  b.gates.regular = true;
  const hb = build(config, b);
  assert.deepStrictEqual(hb.problems, []);
  near(sum(hb, /infusion/), 12 * 500, 0.5);
  // A line with no price is left out, and says so.
  b.people[0].regular.push({ id: 'r2', name: 'scan', times: 2, cost: null, since: 'next' });
  const hc = build(config, b);
  near(sum(hc, /scan/), 0);
  assert.ok(hc.notes.some((n) => n.code === 'regular-unpriced'));
});

test('someone at the cap with no month given: other plans are marked "at least"', () => {
  const a = single({ usage: 'counts', counts: { office: 0, therapy: 0, urgent: 0, er: 0 }, dedMet: 400, oopMet: 1800 });
  const hh = build(config, a);
  assert.deepStrictEqual(hh.lowerBound, ['p1']);
  const out = evaluate(config, hh, { view: 'raw' });
  assert.strictEqual(byId(out, 'fern').atLeast, false); // capped there too: exact
  assert.strictEqual(byId(out, 'moss').atLeast, true);
  // Saying which month the cap was hit projects the rate forward and removes the hedge.
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

test('take-home view: premiums are pre-tax, care is not, unless it goes through an FSA or HSA', () => {
  const fern = getPlan(config, 'fern');
  const lichen = getPlan(config, 'lichen');
  const hh = { tierId: 'employee', credit: 0, taxRate: 0.3, fsa: 0, hsa: 0, hsaEligible: true, hsaLimit: 4300 };
  near(yearCost(config, fern, hh, 1000, 'raw'), 160 * 26 + 1000);
  near(yearCost(config, fern, hh, 1000, 'takehome'), 160 * 26 * 0.7 + 1000);
  // FSA of 800 against 1000 of care: 800 of it is pre-tax.
  near(yearCost(config, fern, { ...hh, fsa: 800 }, 1000, 'takehome'), 160 * 26 * 0.7 + 1000 - 0.3 * 800);
  // FSA of 2200 against 1000 of care: all the care is pre-tax. The rest is not a cost
  // of the plan in either view; it goes to other eligible things.
  near(yearCost(config, fern, { ...hh, fsa: 2200 }, 1000, 'takehome'), 160 * 26 * 0.7 + 0.7 * 1000);
  near(yearCost(config, fern, { ...hh, fsa: 2200 }, 1000, 'raw'), 160 * 26 + 1000);
  // HSA: care paid through it is pre-tax. Money set aside beyond the year's care is savings,
  // not a cost and not a credit.
  near(yearCost(config, lichen, { ...hh, hsa: 2100 }, 900, 'takehome'), 80 * 26 * 0.7 + 0.7 * 900);
  near(yearCost(config, lichen, { ...hh, hsa: 2100 }, 2900, 'takehome'), 80 * 26 * 0.7 + 0.7 * 2100 + 800);
  near(yearCost(config, lichen, { ...hh, hsa: 2100 }, 0, 'takehome'), 80 * 26 * 0.7);
  near(perPaycheck(config, fern, { ...hh, fsa: 1440 }, 'raw').total, 160 + 60);
});

test('the pieces of a year add up, and care is paid from the account first', () => {
  const fern = getPlan(config, 'fern');
  const hh = { tierId: 'employee', credit: 0, taxRate: 0.3, fsa: 1100, hsa: 0, hsaEligible: true };
  const b = breakdown(config, fern, hh, { ded: 400, cc: 280, extra: 0 }, 'takehome');
  near(b.premium + b.ded + b.cc + b.extra, b.total);
  near(b.ded + b.cc, 0.7 * 680); // all of the care went through the account
  near(b.account.set, 0.7 * 1100);
  near(b.account.leftover, 420);
  near(b.aside, 0.7 * 420); // left in the account: shown, not counted
  const more = breakdown(config, fern, hh, { ded: 400, cc: 1300, extra: 0 }, 'takehome');
  near(more.ded + more.cc, 0.7 * 1100 + 600); // the account empties; the rest is at face value
  near(more.aside, 0);
  assert.strictEqual(breakdown(config, fern, { ...hh, fsa: 0 }, { ded: 1, cc: 1, extra: 0 }, 'raw').account, null);
});

test('HSA-ineligible household: the high-deductible plan is shown without the HSA tax benefit', () => {
  const a = single({ usage: 'counts', counts: { office: 0, therapy: 0, urgent: 0, er: 0 }, dedMet: 400, oopMet: 400 + 0.15 * 2100 });
  a.adv.hsa = 2900;
  const eligible = evaluate(config, build(config, a));
  a.gates.hsa = true;
  a.hsa.spouseFsa = true;
  const hh = build(config, a);
  assert.strictEqual(hh.hsaEligible, false);
  const blocked = evaluate(config, hh);
  assert.strictEqual(byId(blocked, 'lichen').hsaBlocked, true);
  // 2500 of charges, all under that plan's deductible: paid pre-tax when eligible, at face value when not.
  near(byId(blocked, 'lichen').scenarios.expected.lo - byId(eligible, 'lichen').scenarios.expected.lo, 0.3 * 2500, 1);
  assert.strictEqual(byId(blocked, 'lichen').scenarios.expected.parts.account, null);
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

test('every scenario comes with its pieces, and they add up to its cost', () => {
  const a = single({ usage: 'counts', counts: { office: 6, therapy: 0, urgent: 1, er: 1 }, dedMet: 400, oopMet: 1300 });
  a.adv.fsa = 900;
  for (const view of ['raw', 'takehome']) {
    for (const p of evaluate(config, build(config, a), { view }).plans) {
      for (const s of ['floor', 'expected', 'bad', 'ceiling']) {
        const b = p.scenarios[s].parts;
        near(b.premium + b.ded + b.cc + b.extra, p.scenarios[s].lo);
      }
      near(p.scenarios.floor.parts.premium, p.scenarios.floor.lo);
      assert.ok(p.scenarios.ceiling.lo >= p.scenarios.bad.hi - 0.01);
    }
  }
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

test('how far off the estimate could be: where the cheapest plan changes, and the sentence for it', () => {
  const a = single({ usage: 'counts', counts: { office: 6, therapy: 0, urgent: 0, er: 0 }, dedMet: 400, oopMet: 400 + 120 + 0.15 * 2900 });
  const hh = build(config, a);
  const sens = sensitivity(config, hh, { view: 'raw' });
  assert.strictEqual(sens.cheapestAtZero, 'lichen'); // with no care, the cheapest premium wins
  assert.ok(sens.crossings.length >= 1);
  assert.ok(sens.crossings.every((c, i) => i === 0 || c.k > sens.crossings[i - 1].k));
  // The plan named at the estimate is the one the expected year says is cheapest.
  const out = evaluate(config, hh, { view: 'raw' });
  const cheapest = out.plans.reduce((x, y) => (y.scenarios.expected.lo < x.scenarios.expected.lo ? y : x));
  assert.strictEqual(sens.cheapestAtEstimate, cheapest.id);
  const short = (id) => out.plans.find((p) => p.id === id).short;
  const text = sensitivitySentence(sens, short);
  assert.match(text, new RegExp(`^At your estimate ${cheapest.short} costs least\\. `));
  assert.match(text, /less care than you estimated|more care|times the care|almost no care/);
  // No care to scale: nothing can change, and the sentence says so.
  const none = sensitivity(config, build(config, single({ usage: 'counts', counts: { office: 0, therapy: 0, urgent: 0, er: 0 } })), { view: 'raw' });
  assert.deepStrictEqual(none.crossings, []);
  assert.strictEqual(none.nothingToScale, true);
  assert.match(sensitivitySentence(none, short), /no care in it beyond free checkups/);
  assert.match(sensitivitySentence({ ...sens, crossings: [] }, short), /costs least however much care/);
});

test('leaving mid-year: premiums and care for part of the year', () => {
  const a = single({ usage: 'few' });
  a.currentPlan = null;
  a.events.leaving = { on: true, month: 6 };
  const hh = build(config, a);
  assert.ok(hh.items.every((it) => it.month <= 6));
  near(byId(evaluate(config, hh, { view: 'raw' }), 'fern').premiumYear, 140 * 13);
});
